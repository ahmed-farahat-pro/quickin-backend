// ID change requests — how someone corrects the identity number on their profile
// when they are not allowed to simply type over it.
//
// `users.id_document` used to be a plain editable field on the mobile Edit Profile
// screen: anyone could rewrite their own identity number at any time, with nobody
// reviewing it. That is exactly the manipulation this queue closes. The number is
// now read-only on every client, and changing it means submitting a request with a
// photo of the document, which an operator approves or rejects in /ops.
//
// The photo is the point. A request carrying only a typed number gives the reviewer
// nothing to check it against, so approving would be rubber-stamping and the queue
// would be theatre. `assertReviewable` enforces that at the core, not just in the UI.
//
// Approving does NOT disturb `users.verification_status`: the operator has just
// examined a document to approve the change, which is the same act that grants
// verification in the first place. Resetting a verified host to pending would trip
// the publish gate in host-verification-core and silently pull their live listings
// off the market as a side effect of a typo correction.
//
// Document types are NOT redefined here — host-verification-core owns that
// vocabulary and this queue reuses it, so a request and a verification always mean
// the same thing by 'passport'. This file cannot import it: Node's ESM resolver
// rejects the extension-less relative specifiers used across src/lib/local, and a
// module with no relative imports is the one shape `node --test` can load directly.
// The route passes the already-normalized doc type in. db.ts imports the core,
// never the reverse. See CLAUDE.md → "Standing requirement — docs and tests".
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// write the same Neon rows: mobile submits through the backend, /ops decides through
// the frontend. If they disagreed on what a valid number is, a request accepted on
// one side could be un-reviewable on the other.
// scripts/check-id-change-core-parity.mjs fails if they drift, so edit one copy and
// paste it over the other verbatim.

/** `id_change_requests.status`. A row is created pending and decided exactly once. */
export const ID_CHANGE_STATUSES = ['pending', 'approved', 'rejected'] as const
export type IdChangeStatus = (typeof ID_CHANGE_STATUSES)[number]

/** What an operator can do to a pending request. */
export const ID_CHANGE_ACTIONS = ['approve', 'reject'] as const
export type IdChangeAction = (typeof ID_CHANGE_ACTIONS)[number]

/**
 * Egypt's national ID is exactly 14 digits, which is why `id_verifications.id_number`
 * has always been documented as such. Enforcing it catches the transposed and
 * truncated numbers that a free-text field silently accepted for years. Someone whose
 * national document is not Egyptian has two other doc types to choose from, so this
 * is a real check rather than a wall.
 */
export const NATIONAL_ID_DIGITS = 14
/** Passport and residence-permit numbers vary by issuer, so only the bounds are fixed. */
export const MIN_DOCUMENT_NUMBER_CHARS = 5
export const MAX_DOCUMENT_NUMBER_CHARS = 24
/** The optional note the user writes to explain the correction. */
export const MAX_ID_CHANGE_REASON_CHARS = 300
/** The operator's note, which doubles as the rejection reason shown to the user. */
export const MAX_ID_CHANGE_NOTE_CHARS = 500
/** Same ceiling the listing and verification images use — images live inline in Postgres. */
export const MAX_ID_CHANGE_IMAGE_CHARS = 3_500_000

/** Thrown for input a human should fix; routes map it to HTTP 400. */
export class IdChangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdChangeError'
  }
}

/** Cross-realm-safe check (routes may see an error thrown in another bundle). */
export function isIdChangeError(e: unknown): e is IdChangeError {
  return e instanceof Error && e.name === 'IdChangeError'
}

/**
 * Canonical form of a document number: upper-cased, with the spaces and dashes people
 * type for readability removed. Comparing canonical forms is what stops "A 123-456"
 * and "a123456" being filed as a change when nothing actually changed.
 */
export function canonicalDocumentNumber(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[\s-]+/g, '')
}

/**
 * Validate the number being requested, against the rules for the document it is on.
 * THROWS rather than coercing — a silently corrected identity number is worse than a
 * refused one, because the reviewer would approve a value the user never typed.
 *
 * `docType` is the already-normalized key from host-verification-core; an unknown or
 * absent one falls back to the generic bounds rather than refusing, so adding a doc
 * type there never bricks this queue.
 */
export function normalizeDocumentNumber(v: unknown, docType?: unknown): string {
  const raw = canonicalDocumentNumber(v)
  if (!raw) throw new IdChangeError('Please enter the number on your document')

  if (String(docType ?? '') === 'national_id') {
    if (!/^\d+$/.test(raw)) {
      throw new IdChangeError('A national ID number is digits only')
    }
    if (raw.length !== NATIONAL_ID_DIGITS) {
      throw new IdChangeError(`A national ID number is ${NATIONAL_ID_DIGITS} digits`)
    }
    return raw
  }

  if (!/^[A-Z0-9]+$/.test(raw)) {
    throw new IdChangeError('A document number can only contain letters and numbers')
  }
  if (raw.length < MIN_DOCUMENT_NUMBER_CHARS || raw.length > MAX_DOCUMENT_NUMBER_CHARS) {
    throw new IdChangeError(
      `A document number is between ${MIN_DOCUMENT_NUMBER_CHARS} and ${MAX_DOCUMENT_NUMBER_CHARS} characters`
    )
  }
  return raw
}

/**
 * Refuse a request that asks for the value already on file. Without this the queue
 * fills with no-ops that cost an operator a real decision each.
 */
export function assertActuallyChanges(current: unknown, requested: unknown): void {
  const a = canonicalDocumentNumber(current)
  const b = canonicalDocumentNumber(requested)
  if (a && a === b) {
    throw new IdChangeError('That is already the number on your profile')
  }
}

/**
 * A request an operator can actually decide on. The front of the document is
 * required: approving a typed number with no document to compare it against is not
 * review, and this queue exists precisely to stop unreviewed identity edits.
 */
export function assertReviewable(frontImage: unknown): void {
  if (!frontImage) {
    throw new IdChangeError('Please attach a photo of the front of your document')
  }
}

/** An inline data:image or an http(s) URL, bounded so it fits a Postgres text column. */
export function normalizeDocumentImage(v: unknown, label: string): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  const looksLikeSource = /^(data:image\/|https?:\/\/)/i.test(s)
  // A bare base64 body is what the mobile image pickers produce; wrap it rather than
  // refusing, the same way the verification route has always done.
  const normalized = looksLikeSource ? s : `data:image/jpeg;base64,${s.replace(/\s+/g, '')}`
  if (!/^(data:image\/|https?:\/\/)/i.test(normalized)) {
    throw new IdChangeError(`${label} must be an image`)
  }
  if (normalized.length > MAX_ID_CHANGE_IMAGE_CHARS) {
    throw new IdChangeError(`${label} is too large — please use a smaller photo`)
  }
  return normalized
}

/** The user's optional explanation. Empty becomes null so the column stays honest. */
export function normalizeIdChangeReason(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (s.length > MAX_ID_CHANGE_REASON_CHARS) {
    throw new IdChangeError(`Please keep the reason under ${MAX_ID_CHANGE_REASON_CHARS} characters`)
  }
  return s
}

/** The operator's note. Doubles as the rejection reason the user is shown. */
export function normalizeIdChangeNote(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (s.length > MAX_ID_CHANGE_NOTE_CHARS) {
    throw new IdChangeError(`Please keep the note under ${MAX_ID_CHANGE_NOTE_CHARS} characters`)
  }
  return s
}

/** Read whatever is on the row into a known status. */
export function normalizeIdChangeStatus(v: unknown): IdChangeStatus {
  const s = String(v ?? '').trim().toLowerCase()
  return (ID_CHANGE_STATUSES as readonly string[]).includes(s) ? (s as IdChangeStatus) : 'pending'
}

/** Validate the operator's decision. THROWS — there is no sensible default action. */
export function normalizeIdChangeAction(v: unknown): IdChangeAction {
  const s = String(v ?? '').trim().toLowerCase()
  if (!(ID_CHANGE_ACTIONS as readonly string[]).includes(s)) {
    throw new IdChangeError(`action must be one of: ${ID_CHANGE_ACTIONS.join(', ')}`)
  }
  return s as IdChangeAction
}

/** The status a decision lands the row in. */
export function statusForIdChangeAction(action: IdChangeAction): Exclude<IdChangeStatus, 'pending'> {
  return action === 'approve' ? 'approved' : 'rejected'
}

/** A rejection with no reason leaves the user with nothing to act on. */
export function assertRejectionExplained(action: IdChangeAction, note: string | null): void {
  if (action === 'reject' && !note) {
    throw new IdChangeError('Please say why the request is being rejected')
  }
}

/** Human label for a stored status. */
export function idChangeStatusLabel(v: unknown): string {
  const LABELS: Record<IdChangeStatus, string> = {
    pending: 'Awaiting review',
    approved: 'Approved',
    rejected: 'Rejected',
  }
  return LABELS[normalizeIdChangeStatus(v)]
}

/**
 * Whether the client should offer the "request a change" action.
 *
 * Only a pending request blocks: an approved or rejected one is history, and someone
 * whose request was rejected for a blurry photo has to be able to try again.
 */
export function canRequestIdChange(currentStatus: unknown): boolean {
  if (currentStatus == null || currentStatus === '') return true
  return normalizeIdChangeStatus(currentStatus) !== 'pending'
}
