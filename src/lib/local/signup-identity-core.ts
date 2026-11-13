// Signup identity — every account created from 2026-11-13 on must give a phone
// number and an identity document (type, number, front and back photos) when it
// signs up, guest or host alike. The document goes to the same /ops review queue
// the host application uses; signing up does not wait for it.
//
// Only NEW accounts carry the requirement. `users.identity_required` is set when
// the row is created (email signup or first Google sign-in) and never back-filled,
// so an account that existed before the cutover is never stopped by this module.
//
// What the requirement decides, once it is on:
//   - a Google account that arrived without the documents must complete them
//     before using the app (`identity_complete: false` → the clients' blocking
//     "Complete your account" screen, POST /api/local/account/identity);
//   - a PENDING document does not stop anything — the guest may browse and book;
//   - a REJECTED document stops new bookings until the guest re-uploads (the
//     resubmission is pending again, which lifts the block).
// The host publish gate in host-verification-core is separate and unchanged.
//
// No runtime imports, so `node --test` can import this file directly — see
// README → Testing. Callers import the core, never the reverse. Field validation
// (phone shape, doc type, document number) lives in phone-core,
// host-verification-core and id-change-core; the routes run those and hand this
// module the outcome.

/** id_verifications.source for a document filed with a signup. */
export const SIGNUP_IDENTITY_SOURCE = 'signup' as const

/** Codes a client switches on — never the message. */
export type IdentityBlockCode = 'identity_incomplete' | 'identity_rejected'

export interface IdentityInput {
  /** users.identity_required — true only for accounts created after the cutover. */
  identityRequired: unknown
  /** users.phone, as stored. */
  phone: unknown
  /** Status of the user's latest id_verifications row ('unverified' when none). */
  verificationStatus: unknown
  /** The reviewer's note on that row — the reason, on a rejection. */
  verificationNote?: unknown
}

/** The identity fields every auth response and /api/auth/me carry. */
export interface IdentityState {
  identity_required: boolean
  /** False only while a required account still owes its phone or document. */
  identity_complete: boolean
  verification_status: 'unverified' | 'pending' | 'verified' | 'rejected'
  /** The rejection reason; null in every other state. */
  verification_note: string | null
}

function status(v: unknown): IdentityState['verification_status'] {
  const s = String(v ?? '').trim()
  return s === 'pending' || s === 'verified' || s === 'rejected' ? s : 'unverified'
}

function hasPhone(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * The identity state of an account.
 *
 * "Complete" means the account has handed over everything signup asks for — a
 * phone and a document on file. It says nothing about the review: a pending or
 * rejected document is still complete, because the guest has done their part
 * and the next move belongs to the reviewer (pending) or to the booking block
 * below (rejected). An account without the requirement is always complete.
 */
export function identityState(input: IdentityInput): IdentityState {
  const required = input.identityRequired === true
  const s = status(input.verificationStatus)
  const note = typeof input.verificationNote === 'string' ? input.verificationNote.trim() : ''
  return {
    identity_required: required,
    identity_complete: !required || (hasPhone(input.phone) && s !== 'unverified'),
    verification_status: s,
    verification_note: s === 'rejected' ? note || null : null,
  }
}

/** The refusal a booking request gets, or null when it may go ahead. */
export function bookingIdentityBlock(
  state: IdentityState
): { code: IdentityBlockCode; message: string } | null {
  if (!state.identity_required) return null
  if (!state.identity_complete) {
    return {
      code: 'identity_incomplete',
      message: 'Add your phone number and ID to finish setting up your account before booking',
    }
  }
  if (state.verification_status === 'rejected') {
    return {
      code: 'identity_rejected',
      message: state.verification_note
        ? `Your ID was not approved: ${state.verification_note}. Upload a new one to book.`
        : 'Your ID was not approved. Upload a new one to book.',
    }
  }
  return null
}

/** The message for a phone number another account already uses. */
export const PHONE_TAKEN_MESSAGE = 'This phone number is already used by another account'
