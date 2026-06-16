import { pool } from './pool'

// Money views (S9) — all MOCK / derived (no real gateway, no payout rails).
// Receipt math MUST match the pay route: service fee 10%, method ±5%, minus promo.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

const SERVICE_FEE_RATE = 0.1
const METHOD_RATE: Record<string, number> = { card: 0.05, bank_transfer: -0.05 }
// Platform commission withheld from the host (host keeps the rest).
const HOST_COMMISSION = 0.1

// Static display rates: 1 EGP → X. Display-only; bookings are always charged EGP.
export const CURRENCY_RATES: Record<string, number> = {
  EGP: 1,
  USD: 0.0203,
  EUR: 0.0188,
  GBP: 0.016,
  SAR: 0.0762,
  AED: 0.0746,
}

export function getCurrencies(): { base: string; rates: Record<string, number> } {
  return { base: 'EGP', rates: CURRENCY_RATES }
}

export interface GuestReceipt {
  booking_id: string
  reservation_code: string | null
  title: string
  check_in: string
  check_out: string
  nights: number
  subtotal: number
  serviceFee: number
  method: string
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
            b.total_price::float8 AS subtotal,
            COALESCE(b.payment_method, 'card') AS method,
            b.promo_code,
            COALESCE(b.promo_discount, 0)::float8 AS promo_discount,
            to_char(b.paid_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS paid_at
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.user_id = $1 AND COALESCE(b.payment_status, 'unpaid') = 'paid'
      ORDER BY b.paid_at DESC NULLS LAST`,
    [userId]
  )
  return rows.map((r) => {
    const subtotal = Math.round(Number(r.subtotal))
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE)
    const methodFee = Math.round(subtotal * (METHOD_RATE[r.method] ?? 0))
    const promoDiscount = Math.round(Number(r.promo_discount) || 0)
    const total = Math.max(0, subtotal + serviceFee + methodFee - promoDiscount)
    return {
      booking_id: r.booking_id,
      reservation_code: r.reservation_code,
      title: r.title,
      check_in: r.check_in,
      check_out: r.check_out,
      nights: Math.max(1, Number(r.nights)),
      subtotal,
      serviceFee,
      method: r.method,
      methodFee,
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
  commissionRate: number
  recent: {
    booking_id: string
    title: string
    check_in: string
    check_out: string
    gross: number
    net: number
    status: 'paid_out' | 'upcoming'
    paid_at: string | null
  }[]
}

/** A host's mock earnings: 90% of each paid booking's stay subtotal. A stay
 *  whose checkout has passed counts as "paid out"; otherwise it's pending. */
export async function getHostEarnings(hostId: string): Promise<HostEarnings> {
  if (!isUuid(hostId)) {
    return { currency: 'EGP', totalEarned: 0, paidOut: 0, pending: 0, bookingsCount: 0, commissionRate: HOST_COMMISSION, recent: [] }
  }
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, l.title,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.total_price::float8 AS gross,
            (b.check_out < now()) AS stay_over,
            to_char(b.paid_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS paid_at
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE l.host_id = $1 AND COALESCE(b.payment_status, 'unpaid') = 'paid' AND b.status <> 'cancelled'
      ORDER BY b.paid_at DESC NULLS LAST`,
    [hostId]
  )
  let totalEarned = 0
  let paidOut = 0
  const recent = rows.map((r) => {
    const gross = Math.round(Number(r.gross))
    const net = Math.round(gross * (1 - HOST_COMMISSION))
    totalEarned += net
    const status: 'paid_out' | 'upcoming' = r.stay_over ? 'paid_out' : 'upcoming'
    if (status === 'paid_out') paidOut += net
    return { booking_id: r.booking_id, title: r.title, check_in: r.check_in, check_out: r.check_out, gross, net, status, paid_at: r.paid_at }
  })
  return {
    currency: 'EGP',
    totalEarned,
    paidOut,
    pending: totalEarned - paidOut,
    bookingsCount: rows.length,
    commissionRate: HOST_COMMISSION,
    recent: recent.slice(0, 50),
  }
}
