// Guest disputes — the pure logic behind filing an issue about a stay and
// working it through /ops.
//
// Everything here is a DECISION rather than a query: which bookings can be
// disputed, what a guest may pick from, which status transitions are legal, and
// the bounds on what gets stored.
//
// Duplicated byte-for-byte in quickin-frontend — the mobile apps file through
// the backend project and the console lives in the web one, both against the
// same `disputes` rows, so a drifted copy would mean a category the console
// can't label or a transition one project allows and the other refuses.
// scripts/check-disputes-core-parity.mjs fails the build if they diverge.
//
// No runtime imports, which is what lets test/unit/disputes-core.test.mjs load
// it directly. See README → Testing.

// ── What a guest is complaining about ────────────────────────────────────────

/**
 * The categories a guest picks from. Fixed in code rather than a settings table:
 * all three clients render the same list, /ops filters on it, and it changes
 * about once a year — a CRUD screen for that is more moving parts than it saves.
 *
 * `other` is the escape hatch; the free-text description carries the detail.
 */
export const DISPUTE_CATEGORIES = [
  { key: 'not_as_described', label: 'Listing not as described' },
  { key: 'cleanliness', label: 'Cleanliness' },
  { key: 'checkin', label: 'Check-in or access problem' },
  { key: 'host_unresponsive', label: 'Host unresponsive' },
  { key: 'safety', label: 'Safety or security concern' },
  { key: 'overcharged', label: 'Overcharged / refund request' },
  { key: 'damage', label: 'Damage or missing items' },
  { key: 'other', label: 'Other' },
] as const satisfies ReadonlyArray<{ key: string; label: string }>

export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number]['key']

const CATEGORY_KEYS = new Set<string>(DISPUTE_CATEGORIES.map((c) => c.key))

export function isDisputeCategory(value: unknown): value is DisputeCategory {
  return CATEGORY_KEYS.has(String(value ?? ''))
}

/** Unknown values fall back to 'other' rather than throwing: a row written by a
 *  newer deploy must never make the /ops queue 500 for an older one. */
export function normalizeCategory(value: unknown): DisputeCategory {
  const v = String(value ?? '')
  return CATEGORY_KEYS.has(v) ? (v as DisputeCategory) : 'other'
}

export function categoryLabel(value: unknown): string {
  const key = normalizeCategory(value)
  return DISPUTE_CATEGORIES.find((c) => c.key === key)!.label
}

// ── The lifecycle ────────────────────────────────────────────────────────────

export const DISPUTE_STATUSES = ['open', 'in_review', 'resolved', 'closed'] as const
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number]

const STATUS_KEYS = new Set<string>(DISPUTE_STATUSES)

export function normalizeStatus(value: unknown): DisputeStatus {
  const v = String(value ?? '')
  return STATUS_KEYS.has(v) ? (v as DisputeStatus) : 'open'
}

const STATUS_LABELS: Record<DisputeStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  resolved: 'Resolved',
  closed: 'Closed',
}

export function statusLabel(value: unknown): string {
  return STATUS_LABELS[normalizeStatus(value)]
}

export function statusTone(value: unknown): 'amber' | 'blue' | 'green' | 'grey' {
  switch (normalizeStatus(value)) {
    case 'open': return 'amber'
    case 'in_review': return 'blue'
    case 'resolved': return 'green'
    default: return 'grey'
  }
}

/** The two states that still need someone. This is what the /ops queue and the
 *  alert count on — `resolved` and `closed` are both finished. */
export function needsAction(value: unknown): boolean {
  const s = normalizeStatus(value)
  return s === 'open' || s === 'in_review'
}

/**
 * Legal transitions. Deliberately permissive in one direction and not the other:
 * a resolved dispute can be re-opened (a guest comes back saying it wasn't
 * actually fixed), but `closed` is terminal — that is what "closed" has to mean
 * for the queue to be trustworthy.
 */
const TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  open: ['in_review', 'resolved', 'closed'],
  in_review: ['open', 'resolved', 'closed'],
  resolved: ['in_review', 'closed', 'open'],
  closed: [],
}

export function canTransition(from: unknown, to: unknown): boolean {
  const f = normalizeStatus(from)
  const t = normalizeStatus(to)
  if (f === t) return false // a no-op would write a meaningless history row
  return TRANSITIONS[f].includes(t)
}

/** Why a transition was refused, for the operator. */
export function transitionError(from: unknown, to: unknown): string | null {
  if (canTransition(from, to)) return null
  const f = normalizeStatus(from)
  const t = normalizeStatus(to)
  if (f === t) return `This dispute is already ${STATUS_LABELS[t].toLowerCase()}.`
  if (f === 'closed') return 'A closed dispute cannot be reopened. File a new one instead.'
  return `A dispute cannot go from ${STATUS_LABELS[f].toLowerCase()} to ${STATUS_LABELS[t].toLowerCase()}.`
}

// ── Which bookings can be disputed ───────────────────────────────────────────

/**
 * "Before, during, or after their stay" — a confirmed booking covers before and
 * during, completed covers after.
 *
 * `pending` is excluded: nothing has been agreed yet, so there is no stay to
 * dispute — that is a question for the host, in chat. `cancelled` and `rejected`
 * are excluded too: no stay happened. A guest wanting money back from a
 * cancellation goes through the refund path, not this one.
 */
export const DISPUTABLE_BOOKING_STATUSES = ['confirmed', 'completed'] as const

export function canDisputeBooking(bookingStatus: unknown): boolean {
  return (DISPUTABLE_BOOKING_STATUSES as readonly string[]).includes(String(bookingStatus ?? ''))
}

/** The refusal a guest sees when the booking isn't eligible. */
export function bookingIneligibleReason(bookingStatus: unknown): string {
  const s = String(bookingStatus ?? '')
  if (s === 'pending') return 'This reservation has not been confirmed yet. Message the host if something is unclear.'
  if (s === 'cancelled' || s === 'rejected') return 'This reservation was cancelled, so there is no stay to raise an issue about.'
  return 'You can only raise an issue on a confirmed or completed reservation.'
}

// ── Bounds on what gets stored ───────────────────────────────────────────────

export const MIN_DESCRIPTION_CHARS = 20
export const MAX_DESCRIPTION_CHARS = 4000
export const MAX_PHOTOS = 6
/** ~3.5MB of base64, the same ceiling payment proofs and listing images use. */
export const MAX_PHOTO_CHARS = 3_500_000
export const MAX_NOTE_CHARS = 2000

export class DisputeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DisputeInputError'
  }
}

/** Was this thrown by one of the validators below? (`name` is checked too, so it
 *  still works if the module is instantiated twice in a bundle.) */
export function isDisputeInputError(err: unknown): boolean {
  return err instanceof DisputeInputError || (err instanceof Error && err.name === 'DisputeInputError')
}

/**
 * A description long enough to act on. The minimum is the point: "it was bad"
 * gives whoever picks this up nothing to investigate, and bouncing it at the
 * form is kinder than a follow-up email three days later.
 */
export function normalizeDescription(input: unknown): string {
  const s = String(input ?? '').trim()
  if (!s) throw new DisputeInputError('Please describe what went wrong.')
  if (s.length < MIN_DESCRIPTION_CHARS) {
    throw new DisputeInputError(
      `Please add a bit more detail — at least ${MIN_DESCRIPTION_CHARS} characters, so we can look into it.`,
    )
  }
  return s.slice(0, MAX_DESCRIPTION_CHARS)
}

/** Photos are optional. Anything that isn't a plausible image source is dropped
 *  rather than rejected — a guest with one bad attachment out of four should not
 *  lose the whole dispute they just typed. */
export function normalizePhotos(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .filter((p) => /^(data:image\/|https?:\/\/)/i.test(p) && p.length <= MAX_PHOTO_CHARS)
    .slice(0, MAX_PHOTOS)
}

/** An admin's note on a status change. Optional, bounded, never a fallback. */
export function normalizeNote(input: unknown): string | null {
  const s = String(input ?? '').trim()
  if (!s) return null
  return s.slice(0, MAX_NOTE_CHARS)
}

/** Validate a whole filing in one place, so the two projects' routes can't drift
 *  on what they accept. Throws `DisputeInputError` with a user-facing message. */
export function validateFiling(input: { category: unknown; description: unknown; photos?: unknown }): {
  category: DisputeCategory
  description: string
  photos: string[]
} {
  if (!isDisputeCategory(input.category)) {
    throw new DisputeInputError('Please choose what the issue is about.')
  }
  return {
    category: input.category,
    description: normalizeDescription(input.description),
    photos: normalizePhotos(input.photos),
  }
}

// ── Display ──────────────────────────────────────────────────────────────────

/** "QK-1A2B3C" — a short, quotable handle for a dispute in an email or a call.
 *  Derived from the id, so it needs no column and can never disagree with it. */
export function disputeReference(id: unknown): string {
  const hex = String(id ?? '').replace(/-/g, '').slice(0, 6).toUpperCase()
  return hex ? `QK-${hex}` : '—'
}

/** The one-line summary of an event for the history timeline. */
export function eventSummary(event: { from_status: unknown; to_status: unknown }): string {
  if (!event.from_status) return 'Dispute filed'
  return `${statusLabel(event.from_status)} → ${statusLabel(event.to_status)}`
}
