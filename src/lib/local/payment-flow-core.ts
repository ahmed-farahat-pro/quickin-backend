// Where a booking sits in the Instapay payment flow, and who may do what next.
//
// Pure, and DELIBERATELY free of runtime imports — Node's ESM resolver rejects the
// extension-less relative specifiers the rest of src/lib/local uses, so a module
// with no relative imports is the one shape `node --test` can load directly.
// db.ts imports this; never the reverse. See README → Testing.
//
// NOT the same thing as payment-config-core.ts, which is about the *destination*
// (handle, QR, link) and is byte-parity-guarded across both repos. This file is about
// the *flow*, which only the web drives, so it is frontend-only and unguarded.

// ---- Vocabulary -------------------------------------------------------------

/** `payment_proofs.status`. The column is plain text with no CHECK constraint, so
 *  this list is the only thing keeping the vocabulary honest. */
export const PROOF_STATUSES = ['submitted', 'approved', 'rejected', 'disputed'] as const
export type ProofStatus = (typeof PROOF_STATUSES)[number]

/** `bookings.payment_status` — the shared rollup both repos write. */
export const PAYMENT_STATES = [
  'unpaid', 'submitted', 'paid', 'rejected', 'disputed',
  // Written only by the retired Paymob webhook path; read-only as far as we care.
  'pending', 'failed', 'refunded', 'voided',
] as const
export type PaymentState = (typeof PAYMENT_STATES)[number]

/** What an admin can do to a submitted screenshot. */
export const PAYMENT_REVIEW_ACTIONS = ['accept', 'reject'] as const
export type PaymentReviewAction = (typeof PAYMENT_REVIEW_ACTIONS)[number]

export function isPaymentReviewAction(value: unknown): value is PaymentReviewAction {
  return (PAYMENT_REVIEW_ACTIONS as readonly string[]).includes(String(value))
}

export function normalizePaymentState(value: unknown): PaymentState {
  const v = String(value ?? '').trim().toLowerCase()
  return (PAYMENT_STATES as readonly string[]).includes(v) ? (v as PaymentState) : 'unpaid'
}

export function normalizeProofStatus(value: unknown): ProofStatus | null {
  const v = String(value ?? '').trim().toLowerCase()
  return (PROOF_STATUSES as readonly string[]).includes(v) ? (v as ProofStatus) : null
}

// ---- Where a booking is in the flow -----------------------------------------

/**
 * The five states the guest-facing UI cares about.
 *
 * `under_review` is the one that was missing: the web read a *derived*
 * `paid_at IS NULL ? 'unpaid' : 'paid'` field, so a booking with a screenshot already
 * submitted looked identical to one that had never been paid — and the guest was
 * invited to pay a second time. Anything reading payment state should go through
 * `paymentStageFor` rather than testing a status by hand.
 */
export const PAYMENT_STAGES = [
  'not_payable', 'awaiting_payment', 'under_review', 'paid', 'rejected',
] as const
export type PaymentStage = (typeof PAYMENT_STAGES)[number]

export interface PaymentFlowBooking {
  /** bookings.status — pending | confirmed | cancelled | rejected. */
  status?: string | null
  /** The RAW bookings.payment_status (BOOKING_COLS exposes it as `payment_state`). */
  payment_state?: string | null
  /** Latest payment_proofs.status, null when no proof exists. */
  payment_proof_status?: string | null
  /** Set once the payment is confirmed. */
  paid_at?: string | null
}

/**
 * Which stage a booking is at. Order matters: paid wins over everything, then an
 * in-flight review, then a rejection the guest can fix, then payability.
 */
export function paymentStageFor(b: PaymentFlowBooking): PaymentStage {
  const state = normalizePaymentState(b.payment_state)
  const proof = normalizeProofStatus(b.payment_proof_status)

  if (state === 'paid' || proof === 'approved' || b.paid_at) return 'paid'
  // A booking that is gone can't be paid, whatever its payment columns say.
  if (b.status === 'cancelled' || b.status === 'rejected') return 'not_payable'
  // Submitted or escalated — the guest has done their part and is waiting on us.
  if (state === 'submitted' || state === 'disputed' || proof === 'submitted' || proof === 'disputed') {
    return 'under_review'
  }
  if (state === 'rejected' || proof === 'rejected') return 'rejected'
  // Payment only opens once the host has accepted the reservation.
  return b.status === 'confirmed' ? 'awaiting_payment' : 'not_payable'
}

/**
 * The single predicate the payment page, the Pay-now button and the upload API all
 * share, so they cannot disagree about whether a booking is payable.
 *
 * A rejected screenshot IS payable — the guest re-uploads a better photo. Rejecting a
 * blurry transfer must not kill the reservation.
 */
export function canPay(b: PaymentFlowBooking): boolean {
  const stage = paymentStageFor(b)
  return stage === 'awaiting_payment' || stage === 'rejected'
}

/** Copy key for the guest-facing chip, resolved by the caller's i18n namespace. */
export function stageLabelKey(stage: PaymentStage): string {
  const KEYS: Record<PaymentStage, string> = {
    not_payable: 'payment.notPayable',
    awaiting_payment: 'payment.awaitingPayment',
    under_review: 'payment.underReview',
    paid: 'payment.paid',
    rejected: 'payment.rejected',
  }
  return KEYS[stage]
}

export function stageTone(stage: PaymentStage): 'green' | 'amber' | 'red' | 'neutral' {
  if (stage === 'paid') return 'green'
  if (stage === 'under_review') return 'amber'
  if (stage === 'rejected') return 'red'
  return 'neutral'
}

// ---- The admin decision -----------------------------------------------------

export interface PaymentReviewOutcome {
  proofStatus: ProofStatus
  paymentState: PaymentState
  /** Whether to stamp bookings.paid_at. */
  markPaid: boolean
}

/**
 * What an admin's decision writes.
 *
 * Note what is NOT here: `bookings.status`. The old host-review path flipped the whole
 * booking to 'rejected' on a bad screenshot, cancelling a real reservation over a
 * blurry photo. A rejected payment leaves the booking confirmed so the guest can
 * simply upload a clearer one.
 */
export function outcomeFor(action: PaymentReviewAction): PaymentReviewOutcome {
  return action === 'accept'
    ? { proofStatus: 'approved', paymentState: 'paid', markPaid: true }
    : { proofStatus: 'rejected', paymentState: 'rejected', markPaid: false }
}

export const MAX_REJECT_REASON = 500

/** Trim and cap the reason shown back to the guest; empty becomes null. */
export function normalizeRejectReason(value: unknown): string | null {
  const v = String(value ?? '').trim()
  if (!v) return null
  return v.length > MAX_REJECT_REASON ? v.slice(0, MAX_REJECT_REASON) : v
}

// ---- Upload validation ------------------------------------------------------

/** Matches the server's MAX_PROOF_BYTES and the client compressor's default target. */
export const MAX_PROOF_CHARS = 3_500_000

export class PaymentProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentProofError'
  }
}

/**
 * Validate a submitted screenshot. Accepts a base64 image data URL or an https link,
 * matching what the backend has always accepted — so a mobile client and the web can
 * post the same body.
 */
export function assertProofImage(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) throw new PaymentProofError('Please attach a screenshot of your transfer')
  if (!/^data:image\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new PaymentProofError('That does not look like an image')
  }
  if (raw.length > MAX_PROOF_CHARS) {
    throw new PaymentProofError('That screenshot is too large (max ~3.5MB)')
  }
  return raw
}
