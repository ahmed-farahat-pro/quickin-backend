import { NextResponse } from 'next/server'
import { getBookingById, markBookingPaid } from '@/lib/local/db'
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
    // (Card details in the body, if any, are ignored — this is a mock.)

    const booking = await markBookingPaid(id, user.id)
    if (!booking) return NextResponse.json({ error: 'Payment could not be recorded' }, { status: 500, headers: CORS })

    const nights = Math.max(
      1,
      Math.round((new Date(booking.check_out).getTime() - new Date(booking.check_in).getTime()) / 86_400_000)
    )
    const subtotal = Math.round(booking.total_price)
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE)
    const total = subtotal + serviceFee
    const receipt = {
      currency: 'EGP',
      nights,
      nightly: Math.round(subtotal / nights),
      subtotal,
      serviceFee,
      total,
      reference: booking.reservation_code,
      paidAt: booking.paid_at,
      method: 'mock',
    }
    return NextResponse.json({ ok: true, booking, receipt }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Payment failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
