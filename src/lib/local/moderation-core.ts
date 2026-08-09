// Moderation — the pure logic behind /ops → Moderation and the warning gate.
//
// A blocked message (see contentguard.ts) is recorded as a `policy_violations`
// row. This module holds everything about those rows that is a DECISION rather
// than a query: what counts as flagged, what a moderator may do about it, the
// wording the user sees, and how a warning's acknowledge gate behaves.
//
// It is duplicated byte-for-byte in quickin-frontend — the web console issues the
// warnings and the mobile apps hit the gate through the backend, so a drifted
// copy would mean a user warned on one project and free to chat on the other.
// scripts/check-moderation-core-parity.mjs fails the build if they diverge.
//
// No runtime imports, which is what lets test/unit/moderation-core.test.mjs load
// it directly. See README → Testing.

// ── What was found, and where ────────────────────────────────────────────────

/** Mirrors contentguard's GuardKind. Kept as a plain list here so this module
 *  stays import-free; `normalizeKind` is the guard against the two drifting. */
export const VIOLATION_KINDS = ['phone', 'email', 'social', 'url'] as const
export type ViolationKind = (typeof VIOLATION_KINDS)[number]

export const VIOLATION_SURFACES = ['chat', 'review', 'listing', 'profile'] as const
export type ViolationSurface = (typeof VIOLATION_SURFACES)[number]

const KIND_LABELS: Record<ViolationKind, string> = {
  phone: 'Phone number',
  email: 'Email address',
  social: 'Social handle',
  url: 'External link',
}

const SURFACE_LABELS: Record<ViolationSurface, string> = {
  chat: 'Chat',
  review: 'Review',
  listing: 'Listing',
  profile: 'Profile',
}

/** Unknown values fall back rather than throw: a row written by a newer deploy
 *  must never make the moderation screen 500 for an older one. */
export function normalizeKind(value: unknown): ViolationKind {
  const v = String(value ?? '').toLowerCase()
  return (VIOLATION_KINDS as readonly string[]).includes(v) ? (v as ViolationKind) : 'phone'
}

export function normalizeSurface(value: unknown): ViolationSurface {
  const v = String(value ?? '').toLowerCase()
  return (VIOLATION_SURFACES as readonly string[]).includes(v) ? (v as ViolationSurface) : 'chat'
}

export function kindLabel(kind: unknown): string {
  return KIND_LABELS[normalizeKind(kind)]
}

export function surfaceLabel(surface: unknown): string {
  return SURFACE_LABELS[normalizeSurface(surface)]
}

// ── What counts as flagged ───────────────────────────────────────────────────

/**
 * How many blocked attempts put a user on the moderation queue.
 *
 * One. Not three. The guard already refused the message, so a row here is not a
 * suspicion — it is a recorded attempt to hand over contact details, and the
 * platform's whole revenue model is that this doesn't happen. A threshold would
 * mean the first two attempts by every user are invisible, which is exactly the
 * population worth seeing: someone testing whether the filter can be beaten.
 */
export const FLAG_THRESHOLD = 1

/** True if this many recorded attempts puts the user in front of a moderator. */
export function isFlagged(violationCount: number): boolean {
  return (Number(violationCount) || 0) >= FLAG_THRESHOLD
}

// ── The bound on stored text ─────────────────────────────────────────────────

/** The full attempted text is stored so a moderator can judge intent, but a
 *  paste of a novel is evidence of nothing — and `body` is read back into a
 *  browser. Chat itself caps at 2000, so this only ever bites on a listing
 *  description. */
export const MAX_BODY_CHARS = 2000

export function truncateBody(text: unknown): string {
  const s = String(text ?? '')
  return s.length <= MAX_BODY_CHARS ? s : s.slice(0, MAX_BODY_CHARS - 1) + '…'
}

// ── What a moderator can do ──────────────────────────────────────────────────

/**
 * `warn`    — issue a warning the user must acknowledge before chatting again.
 * `suspend` — reversible block, reusing the existing account-status lifecycle
 *             (`adminSetAccountStatus`), so listings hide and unhide the way they
 *             already do everywhere else. Permanent REMOVAL is deliberately not
 *             here: it stays behind the `users` module, so a moderator granted
 *             only `moderation` can stop someone without being able to erase them.
 * `dismiss` — a false positive, or a first slip not worth acting on. Marks the
 *             rows reviewed and nothing else.
 *
 * All three mark the user's outstanding violations reviewed, which is what drains
 * the alert. Without that the count only ever climbs and the alert centre trains
 * people to ignore it.
 */
export const MODERATION_ACTIONS = ['warn', 'suspend', 'dismiss'] as const
export type ModerationAction = (typeof MODERATION_ACTIONS)[number]

export function isModerationAction(value: unknown): value is ModerationAction {
  return (MODERATION_ACTIONS as readonly string[]).includes(String(value ?? ''))
}

/** The staff_audit_log action name for each. Prefixed so they group with the
 *  other moderation entries when the audit log is filtered by action. */
export function auditActionFor(action: ModerationAction): string {
  return `moderation_${action}`
}

// ── The warning the user sees ────────────────────────────────────────────────

export const MAX_WARNING_CHARS = 1000

/**
 * The default text when a moderator doesn't write their own. It has to work as
 * the entire message — under the chosen design nothing else notifies the user, so
 * this is read for the first time in a dialog that is blocking their chat.
 */
export const DEFAULT_WARNING =
  'You tried to share contact details in chat. QuickIn keeps conversations and payments on the platform ' +
  'so both sides stay protected — bookings made off-platform have no cover if something goes wrong. ' +
  'Please keep it here. Repeated attempts can lead to your account being suspended.'

/** Trim, bound, and fall back to the default on an empty custom message. */
export function normalizeWarning(input: unknown): string {
  const s = String(input ?? '').trim()
  if (!s) return DEFAULT_WARNING
  return s.length <= MAX_WARNING_CHARS ? s : s.slice(0, MAX_WARNING_CHARS - 1) + '…'
}

/**
 * The response body a chat send gets while a warning is unacknowledged.
 *
 * `policyWarning` is the key the clients branch on to show the acknowledge
 * dialog. A client that doesn't know about it still displays `error`, which is
 * why `error` carries the warning text rather than a generic refusal — an old
 * build then shows the user the actual warning instead of a dead end.
 */
export function warningGateBody(warning: { id: string; message: string }): {
  error: string
  policyWarning: { id: string; message: string }
} {
  return {
    error: warning.message,
    policyWarning: { id: warning.id, message: warning.message },
  }
}

/** The status a warning gate answers with. 409 rather than 403: the request was
 *  authenticated and allowed, it just needs something resolved first — and 403
 *  already means "blocked account" on these routes, which the clients route to a
 *  different screen. */
export const WARNING_GATE_STATUS = 409

// ── Display helpers ──────────────────────────────────────────────────────────

/** "3 attempts", "1 attempt" — used in the queue and the alert row. */
export function attemptsLabel(count: number): string {
  const n = Math.max(0, Number(count) || 0)
  return `${n} attempt${n === 1 ? '' : 's'}`
}

/**
 * A one-line summary of what a user has been doing, e.g.
 * "2 phone, 1 external link". Ordered by count so the dominant behaviour leads.
 */
export function violationSummary(counts: Partial<Record<string, number>>): string {
  const parts = VIOLATION_KINDS.map((k) => ({ k, n: Math.max(0, Number(counts?.[k] ?? 0) || 0) }))
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n || VIOLATION_KINDS.indexOf(a.k) - VIOLATION_KINDS.indexOf(b.k))
  if (!parts.length) return '—'
  return parts.map((p) => `${p.n} ${KIND_LABELS[p.k].toLowerCase()}`).join(', ')
}
