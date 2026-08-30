import { pool } from './pool'
import { COMMISSION_RATE_SQL, parseRate, sqlWithCommission } from './commission-core'
import { sqlHasRetainedValue, sqlRefundPercent, sqlRetained } from './host-retention-core'

// Money views (S9) — derived (no real gateway, no payout rails).
//
// PRICING MODEL — markup, not fees. The host is paid their raw price in full;
// the guest is quoted raw × (1 + commission rate). Receipt math MUST match the
// pay route: commission-inclusive total, minus promo. Nothing else.
//
// This replaced a fee model that charged the guest a 10% service fee AND
// withheld 10% from the host. Both are gone: `serviceFee` and `methodFee`
// survive on the receipt as hardcoded zeros ONLY so that already-installed
// mobile builds, whose decoders require the keys, keep working. Remove them once
// those builds are retired.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

/** The rate to price a booking by: its snapshot, else the live setting. */
const BOOKING_RATE_SQL = `COALESCE(b.commission_rate, ${COMMISSION_RATE_SQL})`

// Currencies QuickIn displays (EGP base). Display-only — bookings are always EGP.
const DISPLAY_CURRENCIES = ['EGP', 'USD', 'EUR', 'GBP', 'SAR', 'AED'] as const

// Static fallback (1 EGP → X) used when the live feed is unreachable.
export const CURRENCY_RATES: Record<string, number> = {
  EGP: 1,
  USD: 0.0203,
  EUR: 0.0188,
  GBP: 0.016,
  SAR: 0.0762,
  AED: 0.0746,
}

// Live EGP rates source. There is no official public JSON API from CIB / the
// Central Bank of Egypt, so we use a keyless interbank FX feed (EGP base) that
// tracks the same market rates the CBE publishes. Override with FX_RATES_URL
// (must return JSON `{ rates: { USD: .., ... } }` with EGP as the base).
const FX_URL = process.env.FX_RATES_URL?.trim() || 'https://open.er-api.com/v6/latest/EGP'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h — rates move slowly; keep upstream calls cheap.

let cache: { at: number; rates: Record<string, number>; source: string } | null = null

/** EGP-based display rates: live (cached 6h) with a static fallback. */
export async function getCurrencies(): Promise<{ base: string; rates: Record<string, number>; source: string; updatedAt: string | null }> {
  // Serve a warm cache.
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { base: 'EGP', rates: cache.rates, source: cache.source, updatedAt: new Date(cache.at).toISOString() }
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(FX_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`FX feed ${res.status}`)
    const data = await res.json()
    const live = data?.rates ?? data?.conversion_rates ?? null
    if (!live || typeof live !== 'object') throw new Error('FX feed: no rates')
    const rates: Record<string, number> = { EGP: 1 }
    for (const code of DISPLAY_CURRENCIES) {
      const v = Number(live[code])
      if (Number.isFinite(v) && v > 0) rates[code] = v
      else if (CURRENCY_RATES[code]) rates[code] = CURRENCY_RATES[code] // backfill any missing code
    }
    const at = Date.now()
    cache = { at, rates, source: 'live' }
    return { base: 'EGP', rates, source: 'live', updatedAt: new Date(at).toISOString() }
  } catch {
    // Unreachable / slow → static fallback (and cache it briefly to avoid hammering).
    cache = { at: Date.now(), rates: CURRENCY_RATES, source: 'fallback' }
    return { base: 'EGP', rates: CURRENCY_RATES, source: 'fallback', updatedAt: null }
  }
}

export interface GuestReceipt {
  booking_id: string
  reservation_code: string | null
  title: string
  check_in: string
  check_out: string
  nights: number
  /** Commission-inclusive stay total. The commission is never itemised. */
  subtotal: number
  /** @deprecated Always 0 — the service fee was replaced by the price markup.
   *  Kept only so shipped mobile decoders don't fail on a missing key. */
  serviceFee: number
  method: string
  /** @deprecated Always 0 — the ±5% card/bank adjustment is gone (Instapay only). */
  methodFee: number
  promoCode: string | null
  promoDiscount: number
  total: number
  paidAt: string | null
  currency: string
}

/** The signed-in guest's paid receipts (recomputed to match the pay route). */
export async function getGuestReceipts(userId: string): Promise<GuestReceipt[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, b.reservation_code, l.title,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            (b.check_out - b.check_in) AS nights,
            ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)}::float8 AS subtotal,
            COALESCE(b.payment_method, 'card') AS method,
            b.promo_code,
            COALESCE(b.promo_discount, 0)::float8 AS promo_discount,
            to_char(b.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS paid_at
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.user_id = $1 AND COALESCE(b.payment_status, 'unpaid') = 'paid'
      ORDER BY b.paid_at DESC NULLS LAST`,
    [userId]
  )
  return rows.map((r) => {
    const subtotal = Math.round(Number(r.subtotal))
    const promoDiscount = Math.round(Number(r.promo_discount) || 0)
    const total = Math.max(0, subtotal - promoDiscount)
    return {
      booking_id: r.booking_id,
      reservation_code: r.reservation_code,
      title: r.title,
      check_in: r.check_in,
      check_out: r.check_out,
      nights: Math.max(1, Number(r.nights)),
      subtotal,
      serviceFee: 0,
      method: r.method,
      methodFee: 0,
      promoCode: r.promo_code ?? null,
      promoDiscount,
      total,
      paidAt: r.paid_at,
      currency: 'EGP',
    }
  })
}

export interface HostEarnings {
  currency: string
  totalEarned: number
  paidOut: number
  pending: number
  bookingsCount: number
  /** The live platform rate — shown to the host as "guests pay N% above your
   *  price", NOT as a deduction. Nothing here is reduced by it. */
  commissionRate: number
  /** What guests were charged in total, across the same bookings. The
   *  difference from totalEarned is the platform's commission. */
  guestPaid: number
  recent: {
    booking_id: string
    title: string
    check_in: string
    check_out: string
    /** What the guest paid and did NOT get back (commission-inclusive). */
    gross: number
    /** What this host earns — their full raw price, less any refunded share. */
    net: number
    /** Kept to two values on purpose: shipped mobile decoders switch on it.
     *  A cancellation the host kept money on reads 'paid_out' — the stay will
     *  never happen, so nothing is left to wait for — and is distinguished by
     *  the `cancelled` flag below rather than by a third status string. */
    status: 'paid_out' | 'upcoming'
    paid_at: string | null
    /** True when this booking was cancelled and the host still kept something.
     *  Additive — older clients that don't decode it just see the row. */
    cancelled: boolean
    /** How much of the guest's money went back, 0–100. Non-zero only on a
     *  cancelled row; lets a client render "cancelled — 50% refunded". */
    refundPercent: number
  }[]
}

/**
 * A host's earnings: the FULL raw price of each paid booking. The platform's
 * commission is charged on top of it to the guest, never withheld from the host,
 * so net === the host's own price. A stay whose checkout has passed counts as
 * "paid out"; otherwise it's pending.
 *
 * CANCELLATIONS are worth what was not refunded, not zero. This query used to
 * carry a blanket `b.status <> 'cancelled'`, which meant a cancellation under a
 * no-refund policy — the guest got nothing back and the platform kept every
 * pound — still erased the whole booking from the host's earnings. The host was
 * charged for a refund that never happened. host-retention-core now scales both
 * sides of the money by the surviving fraction, so a 0%-refund cancellation
 * leaves the host whole, a 50% one halves both host and commission, and only a
 * 100% refund drops the row (sqlHasRetainedValue) so it isn't listed as a 0 EGP
 * line inflating bookingsCount.
 */
export async function getHostEarnings(hostId: string): Promise<HostEarnings> {
  const rate = await getCommissionRate()
  if (!isUuid(hostId)) {
    return { currency: 'EGP', totalEarned: 0, paidOut: 0, pending: 0, bookingsCount: 0, commissionRate: rate, guestPaid: 0, recent: [] }
  }
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, l.title,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            ${sqlRetained(sqlWithCommission('b.total_price', BOOKING_RATE_SQL))}::float8 AS gross,
            ${sqlRetained('b.total_price')}::float8 AS net,
            (b.status = 'cancelled') AS cancelled,
            ${sqlRefundPercent()}::int AS refund_percent,
            -- A cancelled booking settles at cancellation: the stay will never
            -- happen, so its retained amount is never "upcoming".
            (b.status = 'cancelled' OR b.check_out < now()) AS stay_over,
            to_char(b.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS paid_at
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE l.host_id = $1 AND COALESCE(b.payment_status, 'unpaid') = 'paid'
        AND ${sqlHasRetainedValue()}
      ORDER BY b.paid_at DESC NULLS LAST`,
    [hostId]
  )
  let totalEarned = 0
  let paidOut = 0
  let guestPaid = 0
  const recent = rows.map((r) => {
    const gross = Math.round(Number(r.gross))
    const net = Math.round(Number(r.net))
    totalEarned += net
    guestPaid += gross
    const status: 'paid_out' | 'upcoming' = r.stay_over ? 'paid_out' : 'upcoming'
    if (status === 'paid_out') paidOut += net
    return {
      booking_id: r.booking_id, title: r.title, check_in: r.check_in, check_out: r.check_out,
      gross, net, status, paid_at: r.paid_at,
      cancelled: r.cancelled === true,
      refundPercent: Number(r.refund_percent) || 0,
    }
  })
  return {
    currency: 'EGP',
    totalEarned,
    paidOut,
    pending: totalEarned - paidOut,
    bookingsCount: rows.length,
    commissionRate: rate,
    guestPaid,
    recent: recent.slice(0, 50),
  }
}

/** The live platform commission rate (fraction). Falls back to the default if
 *  the row is missing, so a half-migrated DB still serves. */
export async function getCommissionRate(): Promise<number> {
  try {
    const { rows } = await pool.query(`SELECT ${COMMISSION_RATE_SQL} AS rate`)
    return parseRate(rows[0]?.rate)
  } catch {
    return parseRate(null)
  }
}

export interface HostAnalytics {
  currency: string
  listings: number
  totalBookings: number
  paidBookings: number
  cancelledBookings: number
  revenue: number
  avgRating: number
  reviewCount: number
  conversionRate: number // paid / total bookings
  byMonth: { month: string; bookings: number; revenue: number }[]
  topListings: { title: string; bookings: number; revenue: number }[]
}

/** A host's performance dashboard: bookings, revenue (host net), rating,
 *  conversion, a 6-month trend, and top listings. All derived (no tracking). */
export async function getHostAnalytics(hostId: string): Promise<HostAnalytics> {
  const empty: HostAnalytics = {
    currency: 'EGP', listings: 0, totalBookings: 0, paidBookings: 0, cancelledBookings: 0,
    revenue: 0, avgRating: 0, reviewCount: 0, conversionRate: 0, byMonth: [], topListings: [],
  }
  if (!isUuid(hostId)) return empty

  const head = await pool.query(
    `SELECT
       (SELECT count(*) FROM listings l WHERE l.host_id = $1)::int AS listings,
       (SELECT count(*) FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE l.host_id = $1)::int AS total_bookings,
       (SELECT count(*) FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE l.host_id = $1 AND COALESCE(b.payment_status,'unpaid') = 'paid')::int AS paid_bookings,
       (SELECT count(*) FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE l.host_id = $1 AND b.status = 'cancelled')::int AS cancelled_bookings,
       COALESCE((SELECT sum(${sqlRetained('b.total_price')}) FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE l.host_id = $1 AND COALESCE(b.payment_status,'unpaid') = 'paid'), 0)::float8 AS gross_revenue,
       COALESCE((SELECT round(avg(r.rating)::numeric, 2) FROM reviews r JOIN listings l ON l.id = r.listing_id WHERE l.host_id = $1), 0)::float8 AS avg_rating,
       (SELECT count(*) FROM reviews r JOIN listings l ON l.id = r.listing_id WHERE l.host_id = $1)::int AS review_count`,
    [hostId]
  )
  const h = head.rows[0]

  const monthly = await pool.query(
    `SELECT to_char(date_trunc('month', b.paid_at), 'YYYY-MM') AS month,
            count(*)::int AS bookings,
            COALESCE(sum(${sqlRetained('b.total_price')}), 0)::float8 AS revenue
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE l.host_id = $1 AND COALESCE(b.payment_status,'unpaid') = 'paid' AND b.paid_at IS NOT NULL
        AND b.paid_at > now() - interval '6 months'
      GROUP BY 1 ORDER BY 1`,
    [hostId]
  )

  const top = await pool.query(
    // The join no longer excludes cancellations, because a cancelled booking the
    // host kept money on still earned that listing revenue. The count keeps its
    // old meaning via the FILTER — it counts stays, and a cancellation is not one.
    `SELECT l.title,
            count(b.id) FILTER (WHERE b.status <> 'cancelled')::int AS bookings,
            COALESCE(sum(CASE WHEN COALESCE(b.payment_status,'unpaid') = 'paid'
                              THEN ${sqlRetained('b.total_price')} ELSE 0 END), 0)::float8 AS revenue
       FROM listings l LEFT JOIN bookings b ON b.listing_id = l.id
      WHERE l.host_id = $1
      GROUP BY l.id, l.title ORDER BY revenue DESC, bookings DESC LIMIT 5`,
    [hostId]
  )

  const totalBookings = Number(h.total_bookings)
  const paidBookings = Number(h.paid_bookings)
  // Revenue = host net, consistent with the earnings view. Under the markup
  // model that IS the raw total_price the queries above already sum: the
  // commission is added on top for the guest, not withheld from the host —
  // less the refunded share of any cancellation (host-retention-core). Before
  // that, this figure had the opposite bug to getHostEarnings: it applied no
  // cancellation filter at all, so a fully refunded stay counted as full revenue
  // here while a no-refund cancellation counted as nothing there.
  return {
    currency: 'EGP',
    listings: Number(h.listings),
    totalBookings,
    paidBookings,
    cancelledBookings: Number(h.cancelled_bookings),
    revenue: Math.round(Number(h.gross_revenue)),
    avgRating: Number(h.avg_rating),
    reviewCount: Number(h.review_count),
    conversionRate: totalBookings > 0 ? Math.round((paidBookings / totalBookings) * 100) / 100 : 0,
    byMonth: monthly.rows.map((m) => ({
      month: m.month,
      bookings: Number(m.bookings),
      revenue: Math.round(Number(m.revenue)),
    })),
    topListings: top.rows.map((t) => ({
      title: t.title,
      bookings: Number(t.bookings),
      revenue: Math.round(Number(t.revenue)),
    })),
  }
}
