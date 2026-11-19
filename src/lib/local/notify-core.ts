// Admin notifications — the pure rules (no database, no network), so `node --test`
// can load them. admin.ts holds the SQL and imports this; never the reverse.
//
// An operator in /ops → Notifications sends one message either to a whole segment
// (everyone / guests / hosts) or to hand-picked users. This file decides what a
// request body means and refuses the ones that can't be sent.

export const NOTIFY_TITLE_MAX = 120
export const NOTIFY_BODY_MAX = 500
export const NOTIFY_LINK_MAX = 500
/** Hand-picked sends are for a few people. A bigger list is a segment — use one. */
export const NOTIFY_MAX_USERS = 200

export const NOTIFY_AUDIENCES = ['all', 'guests', 'hosts'] as const
export type NotifyAudience = (typeof NOTIFY_AUDIENCES)[number]

export type NotifyTarget =
  | { kind: 'audience'; audience: NotifyAudience }
  | { kind: 'users'; userIds: string[] }

export interface NotifyRequest {
  title: string
  body: string | null
  link: string | null
  target: NotifyTarget
  push: boolean
  email: boolean
}

export class NotifyInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotifyInputError'
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A link is either an in-app path ("/reservations") or an https URL. Anything else
 * (javascript:, http:, a bare word) is refused — the apps open it on tap.
 */
export function normalizeLink(raw: unknown): string | null {
  const s = (raw ?? '').toString().trim()
  if (!s) return null
  if (s.length > NOTIFY_LINK_MAX) throw new NotifyInputError(`Link must be at most ${NOTIFY_LINK_MAX} characters`)
  if (s.startsWith('/') && !s.startsWith('//')) return s
  if (/^https:\/\/[^\s]+$/i.test(s)) return s
  throw new NotifyInputError('Link must be an app path like /reservations or an https:// URL')
}

/** Dedupe, lower-case and validate a list of user ids. */
export function normalizeUserIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new NotifyInputError('user_ids must be a list')
  const seen = new Set<string>()
  for (const v of raw) {
    const id = (v ?? '').toString().trim().toLowerCase()
    if (!UUID_RE.test(id)) throw new NotifyInputError('user_ids contains an invalid id')
    seen.add(id)
  }
  if (seen.size === 0) throw new NotifyInputError('Pick at least one user')
  if (seen.size > NOTIFY_MAX_USERS) {
    throw new NotifyInputError(`At most ${NOTIFY_MAX_USERS} users per send — use a segment for more`)
  }
  return [...seen]
}

/**
 * Turn a request body into a send. `user_ids` (when present) wins over `audience`:
 * a send that names people must never silently widen to a segment.
 */
export function parseNotifyRequest(b: unknown): NotifyRequest {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
  const title = (o.title ?? '').toString().trim()
  if (!title) throw new NotifyInputError('Title is required')
  if (title.length > NOTIFY_TITLE_MAX) throw new NotifyInputError(`Title must be at most ${NOTIFY_TITLE_MAX} characters`)
  const body = (o.body ?? '').toString().trim() || null
  if (body && body.length > NOTIFY_BODY_MAX) throw new NotifyInputError(`Message must be at most ${NOTIFY_BODY_MAX} characters`)
  const link = normalizeLink(o.link)

  let target: NotifyTarget
  if (o.user_ids !== undefined && o.user_ids !== null) {
    target = { kind: 'users', userIds: normalizeUserIds(o.user_ids) }
  } else {
    const a = (o.audience ?? 'all').toString()
    if (!(NOTIFY_AUDIENCES as readonly string[]).includes(a)) throw new NotifyInputError('Unknown audience')
    target = { kind: 'audience', audience: a as NotifyAudience }
  }

  const push = o.push !== false
  // push and email both off is still a real send: the in-app bell shows it.
  const email = o.email === true
  return { title, body, link, target, push, email }
}

/** Search text for the recipient picker: trimmed, capped, and empty when too short. */
export function normalizeRecipientQuery(raw: unknown): string {
  const s = (raw ?? '').toString().trim().slice(0, 80)
  return s.length >= 2 ? s : ''
}

/** Escape LIKE wildcards so a typed "%" or "_" matches itself. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
