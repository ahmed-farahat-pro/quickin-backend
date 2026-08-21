// Activity feed, audit trail and alert-centre rules (F1–F4).
//
// Pure, and DELIBERATELY free of runtime imports — Node's ESM resolver rejects the
// extension-less relative specifiers the rest of src/lib/local uses, so a module
// with no relative imports is the one shape `node --test` can load directly.
// db.ts imports this; never the reverse. See README → Testing.

// ---- F1: the activity feed --------------------------------------------------

/**
 * What the site feed shows. Six of these are DERIVED from timestamps that already
 * exist on real rows — there is no activity_log table — so the feed has full history
 * rather than starting empty on deploy. `login` is the exception: nothing recorded a
 * user sign-in before, so it has its own table.
 */
export const EVENT_KINDS = [
  'signup',
  'login',
  'listing_created',
  'booking_created',
  'payment_submitted',
  'payment_approved',
  'booking_cancelled',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export const ACTIVITY_SORTS = ['recent', 'oldest'] as const
export type ActivitySort = (typeof ACTIVITY_SORTS)[number]

export const DEFAULT_ACTIVITY_LIMIT = 50
export const MAX_ACTIVITY_LIMIT = 200
export const MAX_QUERY_LENGTH = 100

/** Bad user input — the route maps this to HTTP 400, mirroring UserInputError. */
export class ActivityInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActivityInputError'
  }
}

export function isEventKind(value: unknown): value is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(String(value))
}

export function eventLabel(kind: EventKind): string {
  const LABELS: Record<EventKind, string> = {
    signup: 'Signed up',
    login: 'Signed in',
    listing_created: 'Listed a property',
    booking_created: 'Booked a stay',
    payment_submitted: 'Sent a payment',
    payment_approved: 'Payment approved',
    booking_cancelled: 'Cancelled a booking',
  }
  return LABELS[kind] ?? kind
}

/** Badge colour family for the feed. */
export function eventTone(kind: EventKind): 'green' | 'amber' | 'red' | 'neutral' {
  if (kind === 'booking_cancelled') return 'red'
  if (kind === 'payment_submitted') return 'amber'
  if (kind === 'payment_approved' || kind === 'booking_created') return 'green'
  return 'neutral'
}

export interface ActivityFilter {
  /** Empty = every kind. */
  kinds: EventKind[]
  /** Free text on the actor's email or name. */
  q: string | null
  from: string | null
  to: string | null
  sort: ActivitySort
  limit: number
  offset: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function intParam(raw: string | null, fallback: number, min: number, max: number, label: string): number {
  const v = (raw ?? '').trim()
  if (!v) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ActivityInputError(`${label} must be a whole number`)
  if (n < min || n > max) throw new ActivityInputError(`${label} must be between ${min} and ${max}`)
  return n
}

function dateParam(raw: string | null, label: string): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (!DATE_RE.test(v)) throw new ActivityInputError(`${label} must be YYYY-MM-DD`)
  return v
}

function textParam(raw: string | null, label: string): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (v.length > MAX_QUERY_LENGTH) throw new ActivityInputError(`${label} is limited to ${MAX_QUERY_LENGTH} characters`)
  return v
}

function windowParams(get: (k: string) => string | null): { from: string | null; to: string | null } {
  const from = dateParam(get('from'), 'from')
  const to = dateParam(get('to'), 'to')
  if (from && to && from > to) throw new ActivityInputError('from must be on or before to')
  return { from, to }
}

/** Parse the /ops activity query string. `kind` may repeat or be comma-separated. */
export function parseActivityFilter(get: (key: string) => string | null): ActivityFilter {
  const rawKinds = (get('kind') ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  for (const k of rawKinds) {
    if (!isEventKind(k)) throw new ActivityInputError(`Unknown event kind '${k}'`)
  }
  const { from, to } = windowParams(get)
  const sort = ((get('sort') ?? '').trim().toLowerCase() || 'recent') as ActivitySort
  if (!(ACTIVITY_SORTS as readonly string[]).includes(sort)) {
    throw new ActivityInputError(`sort must be one of: ${ACTIVITY_SORTS.join(', ')}`)
  }
  return {
    kinds: rawKinds as EventKind[],
    q: textParam(get('q'), 'Search'),
    from,
    to,
    sort,
    limit: intParam(get('limit'), DEFAULT_ACTIVITY_LIMIT, 1, MAX_ACTIVITY_LIMIT, 'limit'),
    offset: intParam(get('offset'), 0, 0, 1_000_000, 'offset'),
  }
}

/** Whether a branch of the feed's UNION needs to run at all for this filter. */
export function wantsKind(filter: ActivityFilter, kind: EventKind): boolean {
  return filter.kinds.length === 0 || filter.kinds.includes(kind)
}

/**
 * How many rows each UNION branch must fetch.
 *
 * The outer query sorts and pages the merged set, so every branch has to be able to
 * supply the whole page on its own — otherwise a page deep into a single-kind result
 * would come up short. Capped so a large offset can't ask for an unbounded scan.
 */
export function branchLimit(filter: ActivityFilter): number {
  return Math.min(filter.offset + filter.limit, MAX_ACTIVITY_LIMIT + 1_000)
}

// ---- F2: the audit trail ----------------------------------------------------

/** Target types staff_audit_log actually writes today. */
export const AUDIT_TARGET_TYPES = [
  'user', 'listing', 'booking', 'conversation', 'document', 'verification',
  'host_application', 'resort', 'resort_submission', 'staff_account', 'setting',
] as const
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

export interface AuditFilter {
  /** Free text on the acting staff member's email. */
  q: string | null
  action: string | null
  targetType: string | null
  from: string | null
  to: string | null
  limit: number
  offset: number
}

export function parseAuditFilter(get: (key: string) => string | null): AuditFilter {
  const { from, to } = windowParams(get)
  const action = textParam(get('action'), 'Action')
  // The action vocabulary grows with every feature, so this is a shape check rather
  // than an allowlist — but it must never reach SQL as anything but a bound value.
  if (action && !/^[a-z0-9_]+$/.test(action)) {
    throw new ActivityInputError('Action may only contain lowercase letters, digits and underscores')
  }
  const targetType = textParam(get('target_type'), 'Target type')
  if (targetType && !/^[a-z0-9_]+$/.test(targetType)) {
    throw new ActivityInputError('Target type may only contain lowercase letters, digits and underscores')
  }
  return {
    q: textParam(get('q'), 'Search'),
    action,
    targetType,
    from,
    to,
    limit: intParam(get('limit'), DEFAULT_ACTIVITY_LIMIT, 1, MAX_ACTIVITY_LIMIT, 'limit'),
    offset: intParam(get('offset'), 0, 0, 1_000_000, 'offset'),
  }
}

/**
 * Human labels for the audit vocabulary.
 *
 * Naming is inconsistent by history — the staff-management verbs are imperative
 * (`create_staff`) while everything newer is past tense (`user_blocked`). Renaming the
 * old ones would orphan the rows already written, so they are mapped here instead.
 */
const AUDIT_LABELS: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Failed sign-in',
  login_blocked: 'Sign-in blocked (locked out)',
  login_locked: 'Account locked after failed attempts',
  login_deactivated: 'Sign-in refused (deactivated)',
  logout: 'Signed out',
  legacy_fallback: 'Used the legacy admin fallback',
  change_password: 'Changed their password',
  change_password_failed: 'Failed a password change',
  reset_requested: 'Requested a password reset',
  reset_requested_ignored: 'Requested a reset for an unknown account',
  reset_completed: 'Completed a password reset',
  reset_failed: 'Failed a password reset',
  create_staff: 'Created a staff account',
  update_staff: 'Updated a staff account',
  delete_staff: 'Deleted a staff account',
  user_blocked: 'Blocked a user',
  user_unblocked: 'Unblocked a user',
  user_removed: 'Removed a user',
  user_restored: 'Restored a user',
  user_activate_email: 'Marked an email verified',
  user_set_host: 'Changed host access',
  user_thread_viewed: 'Read a message thread',
  document_viewed: 'Opened a document',
  verification_verified: 'Verified an ID',
  verification_rejected: 'Rejected an ID',
  verification_reopened: 'Reopened an ID review',
  host_application_approved: 'Approved a host application',
  host_application_rejected: 'Rejected a host application',
  analytics_export: 'Exported an analytics report',
  resort_create: 'Created a resort',
  resort_update: 'Updated a resort',
  resort_assign: 'Assigned listings to a resort',
  resort_reject: 'Rejected a resort submission',
  resort_merge: 'Merged a resort submission',
  instapay_updated: 'Changed the Instapay destination',
  app_links_updated: 'Changed the app download links',
  dispute_resolved: 'Resolved a payment dispute',
  payment_approved: 'Confirmed a payment',
  payment_rejected: 'Rejected a payment screenshot',
  broadcast_sent: 'Sent a broadcast',
  report_resolved: 'Resolved an abuse report',
  report_dismissed: 'Dismissed an abuse report',
  promo_created: 'Created a promo code',
  promo_deleted: 'Deleted a promo code',
  entity_updated: 'Updated a record',
  entity_deleted: 'Deleted a record',
  seed_super_admin: 'Seeded the first super admin',
}

/** Falls back to humanising the slug, so a new action is readable before it's mapped. */
export function auditActionLabel(action: string): string {
  const known = AUDIT_LABELS[action]
  if (known) return known
  const words = String(action ?? '').replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown action'
}

/**
 * Actions that denote a failed or refused ATTEMPT — rendered in red.
 *
 * Not a suffix match: `user_blocked` ends in `_blocked` but is a successful admin
 * action (an operator blocking someone), while `login_blocked` is a refusal. The
 * distinction is who was stopped, which the slug alone doesn't carry — hence the
 * explicit set.
 */
const FAILURE_ACTIONS = new Set([
  'login_failed', 'login_blocked', 'login_locked', 'login_deactivated',
  'change_password_failed', 'reset_failed', 'reset_requested_ignored',
])

export function isFailureAction(action: string): boolean {
  const a = String(action ?? '')
  return FAILURE_ACTIONS.has(a) || a.endsWith('_failed')
}

/** `staff:<uuid>` is the actor convention in free-text columns; show the readable half. */
export function actorLabel(actor: string | null | undefined): string {
  if (!actor) return 'system'
  const s = String(actor)
  return s.startsWith('staff:') ? `staff ${s.slice(6, 14)}` : s
}

// ---- F4: the alert centre ---------------------------------------------------

/**
 * Every queue that can need attention, with the module that lets an operator act on
 * it and the screen that clears it.
 *
 * Alerts are DERIVED counts, not stored rows: there is no read/unread state to keep
 * in sync, and an alert disappears exactly when the work is done.
 *
 * The first three used to point at `/ops?tab=…`, which never worked: the dashboard
 * sections were React state and nothing ever read that query string, so clicking
 * "3 ID verifications to review" landed on the Overview. They are real routes now.
 */
export const ALERT_SOURCES = [
  { key: 'pending_verifications', label: 'ID verifications to review', module: 'verifications', href: '/ops/verifications' },
  // Its own alert rather than folding into the line above: the two are granted
  // separately, so an operator holding only `id_changes` must still be told there is
  // work, and one holding only `verifications` must not be nagged about a queue they
  // cannot act on. Both land on the same screen.
  { key: 'pending_id_changes', label: 'ID change requests to review', module: 'id_changes', href: '/ops/verifications' },
  { key: 'pending_applications', label: 'Host applications to review', module: 'applications', href: '/ops/applications' },
  { key: 'pending_listings', label: 'Listings awaiting approval', module: 'listings', href: '/ops/listings' },
  { key: 'pending_payments', label: 'Payments to confirm', module: 'payments', href: '/ops/payments' },
  { key: 'disputed_payments', label: 'Payment disputes', module: 'payments', href: '/ops/payments' },
  { key: 'open_reports', label: 'Abuse reports to triage', module: 'reports', href: '/ops/reports' },
  { key: 'pending_resort_submissions', label: 'Resort submissions to review', module: 'resorts', href: '/ops/resorts' },
  { key: 'flagged_users', label: 'Users caught sharing contact details', module: 'moderation', href: '/ops/moderation' },
  { key: 'open_disputes', label: 'Guest disputes to investigate', module: 'disputes', href: '/ops/disputes' },
] as const

export type AlertKey = (typeof ALERT_SOURCES)[number]['key']

export interface Alert {
  key: string
  label: string
  module: string
  href: string
  count: number
}

/**
 * The alerts THIS operator should see.
 *
 * Filtered to the modules they hold, because an alert they cannot act on is noise —
 * a moderator without `payments` shouldn't be nagged about a dispute queue that will
 * 403 them. Zero-count queues are dropped: an alert centre listing six calm zeroes
 * trains people to ignore it.
 */
export function alertsFor(
  counts: Partial<Record<string, number>>,
  opts: { modules: readonly string[]; isSuperAdmin?: boolean },
): Alert[] {
  const held = new Set(opts.modules ?? [])
  return ALERT_SOURCES
    .filter((s) => opts.isSuperAdmin || held.has(s.module))
    .map((s) => ({ ...s, count: Math.max(0, Number(counts?.[s.key] ?? 0) || 0) }))
    .filter((a) => a.count > 0)
}

/** Total badge for the header bell. */
export function alertTotal(alerts: readonly Alert[]): number {
  return alerts.reduce((n, a) => n + a.count, 0)
}

/** "3 days", "4 hours", "just now" — how long the oldest item has waited. */
export function waitingLabel(since: string | null | undefined, now: number): string {
  if (!since) return '—'
  const t = new Date(since).getTime()
  if (Number.isNaN(t)) return '—'
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}
