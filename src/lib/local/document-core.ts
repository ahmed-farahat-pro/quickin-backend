// Document access and account-verification rules for /ops (E1–E4).
//
// Pure, and DELIBERATELY free of runtime imports — Node's ESM resolver rejects the
// extension-less relative specifiers the rest of src/lib/local uses, so a module
// with no relative imports is the one shape `node --test` can load directly.
// db.ts and the document route import this; never the reverse.
// See README → Testing.

// ---- Document kinds ---------------------------------------------------------

/** The four documents /ops can open. `ownership` hangs off a listing; the rest off
 *  an id_verifications row. */
export const DOCUMENT_KINDS = [
  'id_front',
  'id_back',
  'id_selfie',
  'ownership',
  // Documents attached to a request to CHANGE an ID number. They live in
  // id_change_requests, not id_verifications, so they resolve through their own
  // column map below — but they are identity documents like any other, so they get
  // the same audited one-at-a-time channel rather than riding along in a queue
  // payload. See migrate-id-change-requests.mjs for why the two tables are separate.
  'id_change_front',
  'id_change_back',
] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

/** Which `id_verifications` column backs each ID kind. Not a free-text lookup —
 *  the route interpolates this into SQL, so it MUST come from this closed map. */
const ID_COLUMN: Record<string, string> = {
  id_front: 'image_data',
  id_back: 'back_image_data',
  id_selfie: 'selfie_image_data',
}

/** The same closed-map rule for `id_change_requests`. */
const ID_CHANGE_COLUMN: Record<string, string> = {
  id_change_front: 'image_data',
  id_change_back: 'back_image_data',
}

/** True for the kinds stored on an id_change_requests row rather than a verification. */
export function isIdChangeDocumentKind(kind: DocumentKind): boolean {
  return kind in ID_CHANGE_COLUMN
}

/** The column holding this kind's bytes on `id_change_requests`, or null. */
export function idChangeColumnFor(kind: DocumentKind): string | null {
  return ID_CHANGE_COLUMN[kind] ?? null
}

export function isDocumentKind(value: unknown): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(String(value))
}

/** The column holding this kind's bytes, or null for `ownership` (different table). */
export function idColumnFor(kind: DocumentKind): string | null {
  return ID_COLUMN[kind] ?? null
}

/**
 * The module that owns each kind, checked IN ADDITION to `documents`.
 *
 * `documents` is a capability, not a bypass: holding it lets you open a document you
 * could already reach, it does not grant you a queue you were never given. So an
 * operator needs `documents` AND the owning module.
 */
export function owningModuleFor(kind: DocumentKind): 'verifications' | 'listings' | 'id_changes' {
  if (kind === 'ownership') return 'listings'
  // An operator granted only the change queue can open the documents attached to it,
  // and nothing from the verification queue they were not given.
  if (isIdChangeDocumentKind(kind)) return 'id_changes'
  return 'verifications'
}

/** The audit `target_type` for a kind — the SUBJECT the document is about, not the
 *  document itself. Keying the log on the person/listing is what makes
 *  "everything ever opened about this user" a single indexed lookup on
 *  (target_type, target_id), and puts document views in the same keyspace as
 *  user_thread_viewed. The kind and row id go in `detail`. */
export function auditTargetTypeFor(kind: DocumentKind): 'user' | 'listing' {
  return kind === 'ownership' ? 'listing' : 'user'
}

// ---- Data-URL parsing -------------------------------------------------------

/** Image types /ops will render back. SVG is EXCLUDED on purpose: it can carry
 *  script and markup, and these bytes are served to an authenticated admin's
 *  browser. Same reasoning as normalizeQrImage in payment-config-core.ts. */
export const ALLOWED_DOCUMENT_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** What an `ownership` document may additionally be: a PDF. A title deed is
 *  issued as a document, not photographed as one, and the browser renders it in
 *  its own sandboxed viewer — so unlike SVG it never runs as script against the
 *  /ops origin. The ID kinds stay image-only: those are photographs of a card
 *  and a selfie, and a PDF where a photo belongs is a sign of a forwarded scan
 *  rather than a fresh capture.
 *  KEEP IN SYNC with OWNERSHIP_DOC_ACCEPT in ownership-doc-core.ts. */
export const ALLOWED_OWNERSHIP_MIME = [...ALLOWED_DOCUMENT_MIME, 'application/pdf'] as const

/** The mime allowlist for one kind — `ownership` gets PDF, the rest do not. */
export function allowedMimeFor(kind: DocumentKind): readonly string[] {
  return kind === 'ownership' ? ALLOWED_OWNERSHIP_MIME : ALLOWED_DOCUMENT_MIME
}

/** Bad or unsafe stored document — the route maps this to 415/500 rather than
 *  streaming whatever happened to be in the column. */
export class DocumentFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentFormatError'
  }
}

const DATA_URL_RE = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)\s*;\s*base64\s*,\s*([\s\S]*)$/i
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** `normalizeOwnershipDoc` accepts `https://…` as well as a data URL, so a stored
 *  document may be a remote link rather than bytes. The route hands those back as
 *  JSON for the client to open — never a 302, which would leak the operator's
 *  referrer to a third-party host and skip the audit on any refresh. */
export function asDocumentUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  return /^https:\/\/[^\s]+$/i.test(raw) ? raw : null
}

/**
 * Split a stored `data:<mime>;base64,<payload>` into its parts, rejecting anything
 * the given kind does not allow — images for every kind, plus PDF for `ownership`.
 *
 * Deliberately strict: these values were uploaded by users years ago under looser
 * validation, so the read path cannot assume they are well-formed. Throwing beats
 * returning empty bytes, which would render as a silently broken image and look
 * like "no document on file".
 *
 * `kind` is optional and defaults to images only, so a caller that forgets it
 * gets the narrower rule rather than the wider one.
 */
export function parseDocumentDataUrl(
  value: unknown,
  kind?: DocumentKind
): { mime: string; base64: string } {
  const raw = String(value ?? '').trim()
  if (!raw) throw new DocumentFormatError('Document is empty')
  const m = DATA_URL_RE.exec(raw)
  if (!m) throw new DocumentFormatError('Document is not a base64 data URL')
  const mime = m[1].toLowerCase()
  // Normalise the one common alias so a legitimately-stored jpg isn't refused.
  const canonical = mime === 'image/jpg' ? 'image/jpeg' : mime
  const allowed = kind ? allowedMimeFor(kind) : ALLOWED_DOCUMENT_MIME
  if (!(allowed as readonly string[]).includes(canonical)) {
    throw new DocumentFormatError(`Unsupported document type: ${mime}`)
  }
  // Strip the whitespace a wrapped/pretty-printed column may carry.
  const base64 = m[2].replace(/\s+/g, '')
  if (!base64) throw new DocumentFormatError('Document has no data')
  if (!BASE64_RE.test(base64)) throw new DocumentFormatError('Document data is not valid base64')
  return { mime: canonical, base64 }
}

/** Filename extension for an allowlisted document mime, so an operator who saves
 *  the file gets one their machine can open. Every mime the parser lets through
 *  has an entry; anything else falls back to `.bin` rather than guessing. */
export function documentFileExtension(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  }
  return map[mime.toLowerCase()] ?? 'bin'
}

/** Byte length of a base64 payload, without decoding it. */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, (base64.length * 3) / 4 - padding)
}

// ---- Account verification ---------------------------------------------------

/**
 * `users.verification_status` — the single source of truth the mobile apps read.
 * `unverified` means "never submitted"; the other three mirror `id_verifications`.
 */
export const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

/** What an admin can do to a submission. `pending` reopens a decided case. */
export const VERIFICATION_ACTIONS = ['verify', 'reject', 'pending'] as const
export type VerificationAction = (typeof VERIFICATION_ACTIONS)[number]

/** Queue filters for the /ops Verifications tab. */
export const VERIFICATION_FILTERS = ['pending', 'verified', 'rejected', 'all'] as const
export type VerificationFilter = (typeof VERIFICATION_FILTERS)[number]

export function isVerificationAction(value: unknown): value is VerificationAction {
  return (VERIFICATION_ACTIONS as readonly string[]).includes(String(value))
}

/** Filter for the queue; anything unrecognised falls back to 'pending' — the queue
 *  is a work list, so the safe default is "what still needs doing". */
export function normalizeVerificationFilter(value: unknown): VerificationFilter {
  const v = String(value ?? '').trim().toLowerCase()
  return (VERIFICATION_FILTERS as readonly string[]).includes(v) ? (v as VerificationFilter) : 'pending'
}

/** Anything unrecognised reads as 'unverified' — a bad value must never present as
 *  verified, since that drives a trust badge guests rely on. */
export function normalizeVerificationStatus(value: unknown): VerificationStatus {
  const v = String(value ?? '').trim().toLowerCase()
  return (VERIFICATION_STATUSES as readonly string[]).includes(v) ? (v as VerificationStatus) : 'unverified'
}

/** The status an admin action produces, on BOTH id_verifications and users. */
export function statusForAction(action: VerificationAction): Exclude<VerificationStatus, 'unverified'> {
  if (action === 'verify') return 'verified'
  if (action === 'reject') return 'rejected'
  return 'pending'
}

/** Only a verified account carries a timestamp; reopening or rejecting clears it,
 *  so `verified_at` can never outlive the badge it justifies. */
export function verifiedAtForStatus(status: VerificationStatus): 'now' | null {
  return status === 'verified' ? 'now' : null
}

export function verificationLabel(status: VerificationStatus): string {
  if (status === 'verified') return 'Verified'
  if (status === 'rejected') return 'Rejected'
  if (status === 'pending') return 'Pending'
  return 'Not submitted'
}
