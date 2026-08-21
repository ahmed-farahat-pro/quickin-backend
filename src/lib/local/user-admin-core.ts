// Account lifecycle and list filtering for the /ops Users screens (D1–D4).
//
// Pure, and DELIBERATELY free of runtime imports — Node's ESM resolver rejects the
// extension-less relative specifiers the rest of src/lib/local uses, so a module
// with no relative imports is the one shape `node --test` can load directly.
// db.ts imports this; never the reverse. Nothing here may touch `pool`.
// See README → Testing.
//
// NOTE: the backend has a deliberately SMALLER sibling, account-status-core.ts —
// it only needs the status predicate and the rejection copy, because only the web
// writes account status. The two are NOT byte-identical and are NOT parity-guarded
// (unlike resort-core / payment-config-core). Don't "fix" that with a guard script.

// ---- Account status ---------------------------------------------------------

/** The lifecycle of an account. One column, three states — a user can never be
 *  both blocked and removed, and every enforcement site tests one thing. */
export const ACCOUNT_STATUSES = ['active', 'blocked', 'removed'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

/** Filter values for the list screen — the statuses plus 'all'. */
export const USER_STATUS_FILTERS = ['all', ...ACCOUNT_STATUSES] as const
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number]

export const USER_ROLE_FILTERS = ['all', 'host', 'guest'] as const
export type UserRoleFilter = (typeof USER_ROLE_FILTERS)[number]

export const USER_SORTS = ['recent', 'oldest', 'name', 'bookings'] as const
export type UserSort = (typeof USER_SORTS)[number]

export const DEFAULT_USER_LIMIT = 50
export const MAX_USER_LIMIT = 200
export const MAX_QUERY_LENGTH = 100
export const MAX_REASON_LENGTH = 500

/** Bad user input — the route maps this to HTTP 400, mirroring ReportInputError. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserInputError'
  }
}

/** Anything unrecognised reads as 'active'. A NULL/unknown status must never lock
 *  someone out — the column is NOT NULL DEFAULT 'active', but a row written before
 *  the migration (or by a future status this build doesn't know) should still be
 *  able to sign in rather than be silently banned. Fail open HERE, on read of a
 *  value we don't understand; the enforcement sites fail closed on the ones we do. */
export function normalizeStatus(value: unknown): AccountStatus {
  const v = String(value ?? '').trim().toLowerCase()
  return (ACCOUNT_STATUSES as readonly string[]).includes(v) ? (v as AccountStatus) : 'active'
}

/** Operator's note on a block/removal. Empty → null so the column stays clean. */
export function normalizeReason(value: unknown): string | null {
  const v = String(value ?? '').trim()
  if (!v) return null
  return v.length > MAX_REASON_LENGTH ? v.slice(0, MAX_REASON_LENGTH) : v
}

export function statusLabel(status: AccountStatus): string {
  if (status === 'blocked') return 'Blocked'
  if (status === 'removed') return 'Removed'
  return 'Active'
}

/** Badge colour family for the /ops list and profile. */
export function statusTone(status: AccountStatus): 'green' | 'amber' | 'red' {
  if (status === 'blocked') return 'amber'
  if (status === 'removed') return 'red'
  return 'green'
}

// ---- Transitions ------------------------------------------------------------

export const USER_STATUS_ACTIONS = ['block', 'unblock', 'remove', 'restore'] as const
export type UserStatusAction = (typeof USER_STATUS_ACTIONS)[number]

/** What each action means, per starting state. Anything absent is illegal — you
 *  cannot unblock an active account, block a removed one, or restore a live one. */
const TRANSITIONS: Record<UserStatusAction, { from: AccountStatus[]; to: AccountStatus }> = {
  block: { from: ['active'], to: 'blocked' },
  unblock: { from: ['blocked'], to: 'active' },
  remove: { from: ['active', 'blocked'], to: 'removed' },
  restore: { from: ['removed'], to: 'active' },
}

/** The status an action moves an account to. Throws UserInputError (→ 400) when the
 *  action doesn't apply to the current state, so a stale /ops tab can't drive a
 *  nonsense transition. */
export function nextStatusFor(current: AccountStatus, action: UserStatusAction): AccountStatus {
  const rule = TRANSITIONS[action]
  if (!rule) throw new UserInputError(`Unknown action '${action}'`)
  if (!rule.from.includes(current)) {
    throw new UserInputError(`Cannot ${action} an account that is ${statusLabel(current).toLowerCase()}`)
  }
  return rule.to
}

/** Restoring a removed account is the one status action reserved for a super admin
 *  — removal is the most destructive thing /ops can do, so undoing it is a
 *  deliberate second pair of hands. Block/unblock/remove stay at module level so a
 *  moderator can stop a bad actor without waiting. */
export function requiresSuperAdmin(action: UserStatusAction): boolean {
  return action === 'restore'
}

/** Both non-active states hide the account's listings, and returning to active
 *  brings back exactly the ones that hiding took down. Blocking a host who keeps
 *  live listings would leave guests booking someone who cannot log in to answer. */
export function hidesListings(status: AccountStatus): boolean {
  return status !== 'active'
}

/** What a blocked/removed person is told when they try to sign in. Deliberately
 *  the same message for wrong-password and blocked at the *account enumeration*
 *  level — this is only ever returned AFTER the password checks out. */
export function blockedLoginMessage(status: AccountStatus): string {
  if (status === 'removed') {
    return 'This account has been closed. Contact support@quickin.app if you think this is a mistake.'
  }
  return 'Your account has been suspended. Contact support@quickin.app if you think this is a mistake.'
}

// ---- List filter ------------------------------------------------------------

export interface UserListFilter {
  /** Free text matched against email, full name and phone. */
  q: string | null
  status: UserStatusFilter
  role: UserRoleFilter
  /** 'YYYY-MM-DD', inclusive, on created_at. */
  from: string | null
  to: string | null
  sort: UserSort
  limit: number
  offset: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function oneOf<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
  label: string
): T {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return fallback
  if (!(allowed as readonly string[]).includes(v)) {
    throw new UserInputError(`${label} must be one of: ${allowed.join(', ')}`)
  }
  return v as T
}

function intParam(raw: string | null, fallback: number, min: number, max: number, label: string): number {
  const v = (raw ?? '').trim()
  if (!v) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new UserInputError(`${label} must be a whole number`)
  if (n < min || n > max) throw new UserInputError(`${label} must be between ${min} and ${max}`)
  return n
}

function dateParam(raw: string | null, label: string): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (!DATE_RE.test(v)) throw new UserInputError(`${label} must be YYYY-MM-DD`)
  return v
}

/** Parse the /ops users list query string. `get` is `url.searchParams.get`, so this
 *  stays testable without a Request. Bad input throws UserInputError → 400, never a
 *  500 and never a silently-ignored filter. */
export function parseUserListFilter(get: (key: string) => string | null): UserListFilter {
  const rawQ = (get('q') ?? '').trim()
  if (rawQ.length > MAX_QUERY_LENGTH) {
    throw new UserInputError(`Search is limited to ${MAX_QUERY_LENGTH} characters`)
  }
  const from = dateParam(get('from'), 'from')
  const to = dateParam(get('to'), 'to')
  if (from && to && from > to) throw new UserInputError('from must be on or before to')

  return {
    q: rawQ || null,
    status: oneOf(get('status'), USER_STATUS_FILTERS, 'all', 'status'),
    role: oneOf(get('role'), USER_ROLE_FILTERS, 'all', 'role'),
    from,
    to,
    sort: oneOf(get('sort'), USER_SORTS, 'recent', 'sort'),
    limit: intParam(get('limit'), DEFAULT_USER_LIMIT, 1, MAX_USER_LIMIT, 'limit'),
    offset: intParam(get('offset'), 0, 0, 1_000_000, 'offset'),
  }
}

/** WHERE fragments + their bind values for the users list. The caller appends
 *  limit/offset. Every value is a $n placeholder — nothing here is interpolated. */
export function buildUserListWhere(
  filter: UserListFilter,
  startIndex = 1
): { where: string[]; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return `$${startIndex + params.length - 1}`
  }

  if (filter.q) {
    const p = bind(`%${filter.q}%`)
    where.push(`(u.email ILIKE ${p} OR COALESCE(u.full_name, '') ILIKE ${p} OR COALESCE(u.phone, '') ILIKE ${p})`)
  }
  if (filter.status !== 'all') {
    where.push(`COALESCE(u.account_status, 'active') = ${bind(filter.status)}`)
  }
  if (filter.role === 'host') where.push(`COALESCE(u.is_host, false) = true`)
  else if (filter.role === 'guest') where.push(`COALESCE(u.is_host, false) = false`)

  if (filter.from) where.push(`u.created_at >= ${bind(filter.from)}::date`)
  // Widen to the whole final day — created_at is a timestamptz.
  if (filter.to) where.push(`u.created_at < (${bind(filter.to)}::date + interval '1 day')`)

  return { where, params }
}

/** Whitelisted sort orders → safe to interpolate (never accept raw sort text).
 *  Same guard as getListings' ORDER_BY map. */
export function orderBySql(sort: UserSort): string {
  const ORDER: Record<UserSort, string> = {
    recent: 'u.created_at DESC',
    oldest: 'u.created_at ASC',
    name: "COALESCE(NULLIF(u.full_name, ''), u.email) ASC",
    bookings: 'booking_count DESC, u.created_at DESC',
  }
  const sql = ORDER[sort]
  if (!sql) throw new UserInputError(`Unknown sort '${sort}'`)
  return sql
}
