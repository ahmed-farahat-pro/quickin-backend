// What a guest gets back when they cancel.
//
// This module exists because the two projects answered that question differently and
// both answers reached production. For a stay 6 days out, quickin-backend refunded
// 100% of the host's raw price while quickin-frontend refunded 50% of what the guest
// actually paid — same booking, same day, two numbers. Refund maths now lives here,
// once, and both projects call it.
//
// Deliberately dependency-free (no relative imports) so `node --test` can load it —
// see README → Testing. Kept byte-identical across both repos by
// scripts/check-cancellation-core-parity.mjs.

/** The three policies a host may choose. Ordered most to least generous. */
export type CancellationPolicy = 'flexible' | 'moderate' | 'strict'
export const CANCELLATION_POLICIES: CancellationPolicy[] = ['flexible', 'moderate', 'strict']

/**
 * Coerce arbitrary input to a valid policy. Anything missing, blank or unrecognised
 * reads as `moderate` — the same value `listings.cancellation_policy` defaults to in
 * the database, so a listing created before the column existed, a client that omits
 * the field, and a typo all land on the middle ground rather than on the strictest or
 * the most generous terms by accident.
 */
export function normalizePolicy(p?: string | null): CancellationPolicy {
  const v = String(p ?? '').toLowerCase().trim()
  return (CANCELLATION_POLICIES as string[]).includes(v) ? (v as CancellationPolicy) : 'moderate'
}

/**
 * What fraction of what the guest paid comes back, given the policy their booking was
 * taken under and how many whole days remain before check-in.
 *
 *   days ≥ 7   ≥ 5    ≥ 1    day of check-in or later
 *   flexible    100%   100%   100%   0%
 *   moderate    100%   100%    50%   0%
 *   strict       50%     0%     0%   0%
 *
 * `policy` is the SNAPSHOT on the booking, never the listing's current value — a host
 * tightening their terms must not reprice a reservation a guest already agreed to.
 * createBooking has written that snapshot since the column existed, which is why
 * switching this on needed no migration and no backfill.
 *
 * NOTHING refunds on or after the check-in day. The stay has begun; a guest who does
 * not show up has consumed the night the host held for them. This floor is deliberate
 * and applies to `moderate` too — the earlier, unused draft of this ladder returned
 * 50% for moderate no matter how late the cancellation, which would have paid out half
 * a stay to a no-show.
 */
export function refundPercentFor(
  policy: CancellationPolicy | string | null | undefined,
  daysUntilCheckIn: number
): number {
  const d = Number(daysUntilCheckIn)
  if (!Number.isFinite(d) || d < 1) return 0
  switch (normalizePolicy(policy as string)) {
    case 'flexible':
      return 100
    case 'strict':
      return d >= 7 ? 50 : 0
    case 'moderate':
    default:
      return d >= 5 ? 100 : 50
  }
}

/**
 * Money owed back, from the total the GUEST PAID — not the host's raw price.
 *
 * A guest who paid 11,000 (10,000 to the host plus 10% commission) and is owed "50%"
 * receives 5,500, not 5,000. Refunding the raw price would quietly keep the platform's
 * commission on a stay that never happened and hand the guest less than the percentage
 * they were shown. Callers must therefore pass a commission-INCLUSIVE total; in SQL
 * that is `sqlWithCommission('b.total_price', BOOKING_RATE_SQL)`.
 *
 * Rounded to two decimals rather than to a whole unit: the commission-inclusive total
 * is itself derived, so flooring to an integer here would shave a fraction off every
 * refund in the platform's favour.
 */
export function refundAmountFor(guestPaidTotal: number, percent: number): number {
  const total = Number(guestPaidTotal)
  const pct = Number(percent)
  if (!Number.isFinite(total) || !Number.isFinite(pct)) return 0
  return Math.round(total * pct) / 100
}

/** A booking that is already cancelled owes nothing further, whatever the calendar
 *  says. Guards the double-refund that a retried request would otherwise produce. */
export function isCancellable(status: string | null | undefined): boolean {
  const s = String(status ?? '').trim().toLowerCase()
  return s === 'pending' || s === 'confirmed'
}
