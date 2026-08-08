// Platform commission — the single knob that turns a host's raw price into the
// price a guest sees.
//
// MODEL: markup, not deduction. The host names a raw price and is paid exactly
// that; the guest is quoted `raw × (1 + rate)`, rounded UP to the nearest 10 EGP.
// There is no separate service fee and no host-side deduction — this replaced
// both (the old 10% guest service fee + 10% host withholding). The commission is
// never itemised to the guest: they see one inclusive price.
//
// No runtime imports, so `node --test` can import this file directly — see
// CLAUDE.md → "Standing requirement — docs and tests". db.ts imports this
// module; this module never imports db.ts.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// read the same Neon row. scripts/check-commission-core-parity.mjs fails if they
// drift, so edit one copy and paste it over the other verbatim.

/** The app_settings row holding the rate, as a FRACTION string ('0.1' = 10%). */
export const COMMISSION_RATE_KEY = 'platform_commission_rate'

/** Used when the row is missing or unparseable. Matches the value
 *  migrate-analytics.mjs seeded and the constant the old fee model hardcoded, so
 *  a database that never ran the migration behaves exactly as it did before. */
export const DEFAULT_COMMISSION_RATE = 0.1

/** Guest-facing money lands on a multiple of this, always rounding UP. */
export const ROUNDING_STEP = 10

/** An admin may not set a rate outside this band (percent, not fraction). */
export const MIN_COMMISSION_PERCENT = 0
export const MAX_COMMISSION_PERCENT = 100

/** Thrown for admin input a human should fix; routes map it to HTTP 400. */
export class CommissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommissionError'
  }
}

/** Cross-realm-safe check (routes may see an error thrown in another bundle). */
export function isCommissionError(e: unknown): e is CommissionError {
  return e instanceof Error && e.name === 'CommissionError'
}

/**
 * Read the stored app_settings value into a fraction. Anything missing, blank,
 * non-numeric or out of band falls back to DEFAULT_COMMISSION_RATE rather than
 * throwing — a bad row must never take down the public listings feed.
 */
export function parseRate(raw: unknown): number {
  if (raw === null || raw === undefined) return DEFAULT_COMMISSION_RATE
  const s = String(raw).trim()
  // Number('') and Number([]) are both 0, so a blank row would otherwise read as
  // a 0% commission — silently switching the platform off — rather than falling
  // back. setSetting() writes '' to clear a value, so blank rows are realistic.
  if (s === '') return DEFAULT_COMMISSION_RATE
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COMMISSION_RATE
  if (n > MAX_COMMISSION_PERCENT / 100) return DEFAULT_COMMISSION_RATE
  return n
}

/**
 * Validate a percentage an admin typed (`12.5` ⇒ 12.5%) and return the fraction
 * to store. Unlike parseRate this THROWS, because silently ignoring a typo in
 * the admin form would leave the operator believing they changed the rate.
 */
export function rateFromPercent(v: unknown): number {
  const s = String(v ?? '').trim()
  if (s === '') throw new CommissionError('Commission rate is required')
  const n = Number(s)
  if (!Number.isFinite(n)) throw new CommissionError('Commission rate must be a number')
  if (n < MIN_COMMISSION_PERCENT || n > MAX_COMMISSION_PERCENT) {
    throw new CommissionError(`Commission rate must be between ${MIN_COMMISSION_PERCENT}% and ${MAX_COMMISSION_PERCENT}%`)
  }
  // Two decimals of a percent is 0.0001 of a fraction — the precision of
  // bookings.commission_rate (numeric(5,4)), so a stored rate always round-trips.
  return Math.round(n * 100) / 10_000
}

/** Fraction → the percentage shown in the admin form. Inverse of rateFromPercent. */
export function percentFromRate(rate: number): number {
  return Math.round(rate * 10_000) / 100
}

/** The stringified fraction written to app_settings. */
export function rateToStored(rate: number): string {
  return String(Math.round(rate * 10_000) / 10_000)
}

/** Round UP to the nearest ROUNDING_STEP. Exported so the same rule is applied
 *  to derived figures (stay totals) and not just per-night prices. */
export function roundUpToStep(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  // `raw * (1 + rate)` is binary-float, so 100 × 1.1 is 110.00000000000001 and a
  // naive ceil would jump it to 120. Settle to piasters first, then round up.
  const settled = Math.round(n * 100) / 100
  return Math.ceil(settled / ROUNDING_STEP) * ROUNDING_STEP
}

/**
 * The heart of the feature: a host's raw EGP price → what a guest is charged.
 * `null`/`undefined` passes through (weekend_price is nullable and a listing
 * without one must not gain a phantom weekend rate).
 */
export function withCommission(raw: number | null | undefined, rate: number): number | null {
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return roundUpToStep(n * (1 + rate))
}

/** Guest price for a whole `monthly_prices` jsonb map ({"1".."12": nightly}). */
export function monthlyPricesWithCommission(
  monthly: Record<string, unknown> | null | undefined,
  rate: number
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!monthly || typeof monthly !== 'object') return out
  for (const [month, value] of Object.entries(monthly)) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) continue
    out[month] = roundUpToStep(n * (1 + rate))
  }
  return out
}

/** Invert the markup — what the host is owed for a guest-facing figure. Used
 *  only for display; payouts read the raw price straight off the booking. */
export function stripCommission(guestPrice: number, rate: number): number {
  if (!Number.isFinite(guestPrice) || guestPrice <= 0) return 0
  return Math.round(guestPrice / (1 + rate))
}

/** The platform's cut of a raw price, in EGP. */
export function commissionAmount(raw: number, rate: number): number {
  const guest = withCommission(raw, rate) ?? 0
  return Math.max(0, guest - Math.max(0, Math.round(raw)))
}

// ---- SQL ---------------------------------------------------------------------
// The markup also has to run inside Postgres — for the price filter, the sort,
// and the per-night stay sum. These builders keep ONE definition of the rule, so
// the SQL and the TypeScript above can never round differently.

/** Scalar subquery yielding the current rate; safe on a DB with no such row. */
export const COMMISSION_RATE_SQL = `COALESCE((SELECT value::numeric FROM app_settings WHERE key = '${COMMISSION_RATE_KEY}'), ${DEFAULT_COMMISSION_RATE})`

/**
 * Wrap a numeric SQL expression in the markup + round-up rule. `numeric` is
 * exact decimal in Postgres, so the round(...,2) here is belt-and-braces
 * agreement with the JS path rather than a float fix.
 */
export function sqlWithCommission(expr: string, rateSql: string = COMMISSION_RATE_SQL): string {
  return `(ceil(round((${expr}) * (1 + ${rateSql}), 2) / ${ROUNDING_STEP}.0) * ${ROUNDING_STEP})`
}
