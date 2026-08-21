// Host identity verification — the rule that decides whether someone may put a
// listing in front of guests.
//
// A host must be BOTH an approved host (`users.is_host`, set when their
// application is approved) AND identity-verified (`users.verification_status`,
// set when an admin approves their ID documents) before they can create or
// publish a listing. The two are separate facts with separate review steps, and
// this module is the single place that combines them.
//
// The `code` on a refusal matters as much as the message: web, iOS and Android
// each render a different call to action for "you never submitted" vs "we're
// still reviewing" vs "we rejected it, here's why". Clients switch on the code
// and must never parse the message.
//
// No runtime imports, so `node --test` can import this file directly — see
// CLAUDE.md → "Standing requirement — docs and tests". db.ts imports the core,
// never the reverse.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// gate the same Neon rows. scripts/check-host-verification-core-parity.mjs fails
// if they drift, so edit one copy and paste it over the other verbatim.

/** The identity documents a host may submit. Stored in `id_verifications.doc_type`. */
export const DOC_TYPES = [
  { key: 'national_id', label: 'National ID' },
  { key: 'passport', label: 'Passport' },
  { key: 'residence_permit', label: 'Residence permit' },
] as const

export type DocType = (typeof DOC_TYPES)[number]['key']

const DOC_TYPE_KEYS = new Set<string>(DOC_TYPES.map((d) => d.key))

/** `users.verification_status`. 'unverified' is the absence of a submission. */
export const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

/** Why a listing action was refused. Clients switch on this, never on the text. */
export type ListingGateCode =
  | 'ok'
  | 'not_host'
  | 'verification_missing'
  | 'verification_pending'
  | 'verification_rejected'

/** Thrown for host input a human should fix; routes map it to HTTP 400. */
export class HostVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostVerificationError'
  }
}

/** Cross-realm-safe check (routes may see an error thrown in another bundle). */
export function isHostVerificationError(e: unknown): e is HostVerificationError {
  return e instanceof Error && e.name === 'HostVerificationError'
}

/**
 * Validate the document type a host picked. THROWS rather than defaulting:
 * silently filing a passport as a national ID would mislead the reviewer, who
 * checks the photo against the declared type.
 */
export function normalizeDocType(v: unknown): DocType {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!s) throw new HostVerificationError('Please choose which document you are uploading')
  if (!DOC_TYPE_KEYS.has(s)) {
    throw new HostVerificationError(
      `Unknown document type. Choose one of: ${DOC_TYPES.map((d) => d.label).join(', ')}`
    )
  }
  return s as DocType
}

/** Human label for a stored key; falls back to the raw value for legacy rows. */
export function docTypeLabel(v: unknown): string {
  const s = String(v ?? '').trim()
  return DOC_TYPES.find((d) => d.key === s)?.label ?? (s || 'Not specified')
}

/** Read whatever is on the user row into a known status. */
export function normalizeVerificationStatus(v: unknown): VerificationStatus {
  const s = String(v ?? '').trim().toLowerCase()
  return (VERIFICATION_STATUSES as readonly string[]).includes(s)
    ? (s as VerificationStatus)
    : 'unverified'
}

export interface ListingGateInput {
  /** users.is_host — their host application was approved. */
  isHost: boolean
  /** users.verification_status — an admin approved their ID documents. */
  verificationStatus: unknown
  /** Staff bypass the gate; they act on hosts' behalf from /ops. */
  isStaff?: boolean
}

export interface ListingGateResult {
  allowed: boolean
  code: ListingGateCode
  /** Shown to the host verbatim. One wording across web, iOS and Android. */
  message: string
}

const ALLOWED: ListingGateResult = { allowed: true, code: 'ok', message: '' }

/**
 * May this user create or publish a listing?
 *
 * Both conditions are required and checked in this order, because the host
 * application is the earlier step: telling someone "verify your ID" when they
 * are not yet an approved host would send them to a screen that cannot help.
 */
export function canPublishListing(input: ListingGateInput): ListingGateResult {
  if (input.isStaff) return ALLOWED
  if (!input.isHost) {
    return {
      allowed: false,
      code: 'not_host',
      message: 'Only hosts can add a listing. Apply to become a host first.',
    }
  }
  const status = normalizeVerificationStatus(input.verificationStatus)
  if (status === 'verified') return ALLOWED
  if (status === 'pending') {
    return {
      allowed: false,
      code: 'verification_pending',
      message:
        "We're reviewing your identity documents. You can add listings as soon as they're approved.",
    }
  }
  if (status === 'rejected') {
    return {
      allowed: false,
      code: 'verification_rejected',
      message:
        'Your identity documents were not approved. Please upload them again to start listing.',
    }
  }
  return {
    allowed: false,
    code: 'verification_missing',
    message: 'Verify your identity to start listing. It usually takes a day to review.',
  }
}

/** Convenience for call sites that only need the boolean. */
export function isListingAllowed(input: ListingGateInput): boolean {
  return canPublishListing(input).allowed
}

/**
 * Does moving to `next` mean a previously-trusted host is no longer trusted?
 *
 * Losing verification must take their listings off the market — that is the
 * point of the gate — so this drives the unpublish in reviewVerification.
 * Re-opening a case ('pending') counts: while it is under review again the host
 * is not verified, and a listing that stays live through a re-review would be
 * exactly the gap the feature exists to close.
 */
export function revokesListingPrivileges(previous: unknown, next: unknown): boolean {
  return normalizeVerificationStatus(previous) === 'verified' && normalizeVerificationStatus(next) !== 'verified'
}

/**
 * Must someone with this verification status upload identity documents again?
 *
 * A user verifies ONCE, from their profile — the same identity serves guest and
 * host alike. The host application therefore asks for documents only when there
 * is nothing usable on file: a 'verified' submission is already approved, and a
 * 'pending' one is already in the reviewer's queue and will be decided together
 * with the application. Asking either of them to photograph the same ID a second
 * time is the redundancy this function exists to prevent.
 *
 * 'rejected' DOES require new documents — that decision was "these are not good
 * enough", so re-filing the same row would put the same refused photos back in
 * front of the reviewer.
 *
 * The web application form and `submitHostApplication` both read this, so what
 * the applicant is asked for and what the server requires can never disagree.
 */
export function needsIdentityDocuments(status: unknown): boolean {
  const s = normalizeVerificationStatus(status)
  return s !== 'verified' && s !== 'pending'
}

/** The national-ID field of the become-a-host form, decided from the identity
 *  we already hold. `value` is what the field starts with — never null, so a
 *  client can bind it directly; `locked` says show it rather than ask for it. */
export interface ApplicationNationalId {
  value: string
  locked: boolean
}

/**
 * What the become-a-host form should put in its national-ID field.
 *
 * The companion to `needsIdentityDocuments`: that one answers "must they send
 * the document again", this one answers "must they type the number again". Both
 * exist for the same reason — one identity, verified once from the profile,
 * serving guest and host alike.
 *
 * A **verified** submission's number is the one an admin already approved, so it
 * is shown and locked. An application that contradicts the approved document
 * would put the reviewer between two different numbers, and there is no way for
 * them to tell which one the applicant meant.
 *
 * Anything else is a seed, not a decision: a reapply keeps what was typed last
 * time, and failing that we offer the number from a submission still under
 * review (or a rejected one — the photos were refused, the number the applicant
 * gave was not). Both stay editable, because nothing about them is approved yet.
 *
 * Web, iOS and Android all render this same rule (`IdentityRules.swift`,
 * `IdentityRules.kt`), so no client asks for a number another client would have
 * filled in.
 */
export function nationalIdForApplication(args: {
  /** The applicant's verification status (`users.verification_status`). */
  status?: unknown
  /** The number on the identity submission we hold, when it carried one. */
  submittedIdNumber?: unknown
  /** The number on their previous host application, when reapplying. */
  previousNationalId?: unknown
}): ApplicationNationalId {
  const text = (v: unknown) => String(v ?? '').trim()
  const submitted = text(args.submittedIdNumber)
  if (normalizeVerificationStatus(args.status) === 'verified' && submitted) {
    return { value: submitted, locked: true }
  }
  return { value: text(args.previousNationalId) || submitted, locked: false }
}

/** What an ID photo has to look like before we file it. The size cap belongs to
 *  the DB layer (it owns the column); this is only about the shape. */
const ID_IMAGE_RE = /^(?:data:image\/|https?:\/\/)/i

/** True for a value we would store as an ID photo — an inline image or a link. */
export function isIdDocumentImage(value: unknown): boolean {
  return ID_IMAGE_RE.test(String(value ?? '').trim())
}

/** The identity half of a become-a-host application. */
export interface ApplicationIdentityInput {
  /** The applicant's verification status (their latest id_verifications row). */
  verificationStatus: unknown
  /** Which document was photographed — one of DOC_TYPES. */
  docType?: unknown
  /** FRONT photo, as a `data:image/…` URL or an https link. */
  idFront?: unknown
  /** BACK photo, same shapes. */
  idBack?: unknown
}

/**
 * What is missing from the identity half of a host application?
 *
 * An application asks to be trusted with other people's stays, and the reviewer
 * decides it by reading the declared name and national ID against a photographed
 * document. With no document there is nothing to review — an application filed
 * without one can only be approved blind — so it must not be filed at all. This
 * is the rule that says so, and every client and every route reads it, so no
 * surface can accept a submission another surface would have refused.
 *
 * Returns an EMPTY object when nothing is wrong, INCLUDING for an applicant who
 * already has a verified or pending submission: they verified once from their
 * profile and that identity serves guest and host alike — see
 * [needsIdentityDocuments], the companion rule the forms render from.
 *
 * Both sides are required, as the standalone verification flow has always
 * required them: the back carries the expiry and issuing details a reviewer
 * checks the front against.
 *
 * Keys match the request body (`doc_type`, `id_front`, `id_back`) so a client can
 * map a 400's `fields` straight onto its form.
 */
export function checkApplicationIdentity(input: ApplicationIdentityInput): Record<string, string> {
  const fields: Record<string, string> = {}
  if (!needsIdentityDocuments(input.verificationStatus)) return fields
  try {
    normalizeDocType(input.docType)
  } catch (e) {
    fields.doc_type = e instanceof Error ? e.message : 'Please choose which document you are uploading'
  }
  if (!isIdDocumentImage(input.idFront)) {
    fields.id_front = 'A photo of the front of your ID is required'
  }
  if (!isIdDocumentImage(input.idBack)) {
    fields.id_back = 'A photo of the back of your ID is required'
  }
  return fields
}
