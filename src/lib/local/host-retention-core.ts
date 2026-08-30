// What a host KEEPS when a booking is cancelled.
//
// This module exists because "cancelled" was being treated as "worth nothing".
// getHostEarnings filtered `b.status <> 'cancelled'`, so a cancellation under a
// no-refund policy — the guest got nothing back, the platform kept every pound —
// still wiped the whole booking off the host's earnings. The host lost money the
// guest never got. getHostAnalytics had the mirror-image bug: it summed every
// paid booking with no cancellation filter at all, so a fully refunded stay was
// reported as full revenue. Two screens, two opposite wrong answers.
//
// THE RULE: a cancelled booking is worth the fraction of it that was NOT
// refunded, and that fraction applies to BOTH sides of the money — the host's
// raw price and the platform's commission shrink together. A guest who paid
// 11,000 (10,000 to the host + 10% commission) and is refunded 50% leaves 5,500
// behind: 5,000 for the host, 500 for the platform. The platform does not keep a
// full commission on half a stay, and the host does not absorb the whole refund.
//
// A booking that is not cancelled is worth 100% of itself — this module is a
// no-op on the overwhelming majority of rows.
//
// Deliberately dependency-free (no relative imports) so `node --test` can load it
// — see README → Testing. It ships in quickin-backend only; quickin-frontend has
// no data layer any more, so there is no parity copy to keep in sync.

/** Statuses whose money is reduced by a refund. Only cancellation refunds. */
const CANCELLED = 'cancelled'

/**
 * Is this booking's money subject to a refund haircut?
 *
 * Only `cancelled`. `rejected` bookings never reach a paid state, and
 * `refunded`/`voided` live on `payment_status`, which every caller here already
 * filters to `paid` — so a fully reversed payment is excluded before this module
 * ever sees it.
 */
export function isRefundable(status: string | null | undefined): boolean {
  return String(status ?? '').trim().toLowerCase() === CANCELLED
}

/**
 * Coerce `bookings.refund_percent` to a whole 0–100.
 *
 * NULL reads as 0 — NO refund, host keeps the money. That is the same convention
 * the /ops analytics reports already use (`COALESCE(b.refund_percent, 0)`), so
 * the money the operator sees as "not refunded" is exactly the money the host
 * sees as earned. It matters because the admin cancellation path in admin.ts
 * writes no refund_percent at all, and neither did any cancellation taken before
 * the column existed. Reading those as full refunds would silently confiscate a
 * host's earnings on every /ops cancellation.
 */
export function normalizeRefundPercent(pct: unknown): number {
  const n = Number(pct)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(100, n)
}

/**
 * The fraction of a booking's money that survives, 0–1.
 *
 * Not cancelled → 1. Cancelled → (100 − refund%) / 100. Applied to the host's
 * raw price this is the host's earnings; applied to the guest-facing total it is
 * what the platform actually held on to.
 */
export function retainedFraction(
  status: string | null | undefined,
  refundPercent: unknown
): number {
  if (!isRefundable(status)) return 1
  return (100 - normalizeRefundPercent(refundPercent)) / 100
}

/**
 * Money retained, rounded to whole EGP — the JS twin of `sqlRetained`.
 *
 * Whole units, not the two decimals refundAmountFor uses, because every figure
 * in the earnings and analytics views is already whole EGP. Rounding (not
 * flooring) so a 50% refund on an odd total splits without shaving the odd pound
 * off the host's side.
 */
export function retainedAmount(
  amount: number,
  status: string | null | undefined,
  refundPercent: unknown
): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * retainedFraction(status, refundPercent))
}

/**
 * True when a cancelled booking left the host nothing — the row worth hiding
 * from an earnings list rather than showing as a zero.
 */
export function isFullyRefunded(
  status: string | null | undefined,
  refundPercent: unknown
): boolean {
  return isRefundable(status) && normalizeRefundPercent(refundPercent) >= 100
}

// ---- SQL ---------------------------------------------------------------------
// The same rule has to run inside Postgres, because the earnings and analytics
// figures are SUMmed there. One definition, so the two can never disagree.

/** `bookings.refund_percent` clamped to 0–100, NULL → 0. Twin of normalizeRefundPercent. */
export function sqlRefundPercent(alias = 'b'): string {
  return `LEAST(GREATEST(COALESCE(${alias}.refund_percent, 0), 0), 100)`
}

/** The 0–1 survival fraction. Twin of retainedFraction. */
export function sqlRetainedFraction(alias = 'b'): string {
  return `(CASE WHEN ${alias}.status = '${CANCELLED}' THEN (100 - ${sqlRefundPercent(alias)}) / 100.0 ELSE 1 END)`
}

/**
 * Wrap a numeric SQL expression in the retention rule. Twin of retainedAmount.
 *
 * `expr` may itself be a commission-inclusive figure (sqlWithCommission(...)) —
 * shrinking the guest-facing total and the host's raw price by the same fraction
 * is exactly the proportional split this module implements.
 */
export function sqlRetained(expr: string, alias = 'b'): string {
  return `((${expr}) * ${sqlRetainedFraction(alias)})`
}

/**
 * WHERE fragment dropping cancellations that left the host nothing, while
 * keeping the partial ones. Without it a 100%-refunded booking would appear in
 * the earnings list as a 0 EGP row and inflate bookingsCount.
 */
export function sqlHasRetainedValue(alias = 'b'): string {
  return `(${alias}.status <> '${CANCELLED}' OR ${sqlRefundPercent(alias)} < 100)`
}
