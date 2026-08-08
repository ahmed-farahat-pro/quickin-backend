import { NextResponse } from 'next/server'
import { getBookingById, markBookingPaid, setBookingPromo } from '@/lib/local/db'
import { redeemPromo } from '@/lib/local/promote'
import { getUserFromRequest } from '@/lib/local/auth'

// POST /api/local/bookings/:id/pay — MOCK checkout. There is no real gateway yet
// (Paymob comes later); this always "succeeds" for the booking owner, marks it
// paid + confirmed, and returns a receipt. When Paymob lands, only the internals
// change — the request/response contract (and every client) stays the same.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}
// No fees are added here any more. `booking.total_price` already arrives
// COMMISSION-INCLUSIVE from BOOKING_COLS (raw host price × the rate snapshotted
// on the booking), which replaced both the 10% guest service fee and the ±5%
// card/bank-transfer adjustment — Instapay is the only method now. `serviceFee`
// and `methodFee` stay on the receipt as zeros for shipped mobile decoders.

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in to pay' }, { status: 401, headers: CORS })

    const existing = await getBookingById(id)
    if (!existing) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    if (existing.user_id !== user.id) {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403, headers: CORS })
    }
    // The method is still recorded on the booking, but it no longer moves the
    // price. Card details, if any, are ignored — this is a mock.
    const body = await req.json().catch(() => ({}))
    const method = body?.method === 'bank_transfer' ? 'bank_transfer' : 'card'

    const booking = await markBookingPaid(id, user.id, method)
    if (!booking) return NextResponse.json({ error: 'Payment could not be recorded' }, { status: 500, headers: CORS })

    const nights = Math.max(
      1,
      Math.round((new Date(booking.check_out).getTime() - new Date(booking.check_in).getTime()) / 86_400_000)
    )
    const subtotal = Math.round(booking.total_price)
    // Optional promo code — redeemed against the subtotal (one-time increment).
    let promoCode: string | null = null
    let promoDiscount = 0
    const rawPromo = typeof body?.promo_code === 'string' ? body.promo_code : typeof body?.promoCode === 'string' ? body.promoCode : ''
    if (rawPromo && rawPromo.trim()) {
      promoDiscount = await redeemPromo(rawPromo, subtotal)
      if (promoDiscount > 0) {
        const normalized = rawPromo.trim().toUpperCase()
        promoCode = normalized
        await setBookingPromo(id, user.id, normalized, promoDiscount)
      }
    }
    const total = Math.max(0, subtotal - promoDiscount)
    const receipt = {
      currency: 'EGP',
      nights,
      nightly: Math.round(subtotal / nights),
      subtotal,
      serviceFee: 0, // deprecated — see the note at the top of this file
      method,
      methodFee: 0, // deprecated
      promoCode,
      promoDiscount, // amount subtracted by the promo code (0 if none)
      total,
      reference: booking.reservation_code,
      paidAt: booking.paid_at,
    }
    return NextResponse.json({ ok: true, booking, receipt }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Payment failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
