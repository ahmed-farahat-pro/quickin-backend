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
// Mocked guest service fee added on top of the stay subtotal.
const SERVICE_FEE_RATE = 0.1
// Payment-method adjustment on the subtotal: paying by card adds 5%, paying by
// bank transfer takes 5% off. (Mock — no real gateway yet.)
const METHOD_RATE: Record<string, number> = { card: 0.05, bank_transfer: -0.05 }

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
    // Payment method drives a ±5% adjustment (card +5%, bank transfer −5%).
    // Card details, if any, are ignored — this is a mock.
    const body = await req.json().catch(() => ({}))
    const method = body?.method === 'bank_transfer' ? 'bank_transfer' : 'card'

    const booking = await markBookingPaid(id, user.id, method)
    if (!booking) return NextResponse.json({ error: 'Payment could not be recorded' }, { status: 500, headers: CORS })

    const nights = Math.max(
      1,
      Math.round((new Date(booking.check_out).getTime() - new Date(booking.check_in).getTime()) / 86_400_000)
    )
    const subtotal = Math.round(booking.total_price)
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE)
    // Signed: positive surcharge for card, negative discount for bank transfer.
    const methodFee = Math.round(subtotal * (METHOD_RATE[method] ?? 0))
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
    const total = Math.max(0, subtotal + serviceFee + methodFee - promoDiscount)
    const receipt = {
      currency: 'EGP',
      nights,
      nightly: Math.round(subtotal / nights),
      subtotal,
      serviceFee,
      method,
      methodFee, // +ve = card surcharge, −ve = bank-transfer discount
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
