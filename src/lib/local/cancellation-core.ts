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

/**
 * ONE FLAT POLICY, on purpose — pending a business decision.
 *
 * `listings.cancellation_policy` still exists, hosts still set it, and createBooking
 * still snapshots it onto every booking row. Nothing reads it yet. That is the point:
 * when the per-listing flexible/moderate/strict ladder is agreed, switching it on is a
 * change to this file plus a read of the snapshot — not a migration and not a
 * backfill, because the data has been recorded the whole time.
 *
 * Until then every listing refunds on this single ladder:
 *   7 or more days before check-in ... 100%
 *   1 to 6 days before ...............  50%
 *   day of check-in or later .........   0%
 */
export function refundPercentForDays(daysUntilCheckIn: number): number {
  const d = Number(daysUntilCheckIn)
  if (!Number.isFinite(d)) return 0
  if (d >= 7) return 100
  if (d >= 1) return 50
  return 0
}

/** The label reported to clients while the policy is flat. Clients show this to the
 *  guest, so it must not claim a per-listing policy the refund maths does not honour. */
export const FLAT_POLICY_LABEL = 'moderate'

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
