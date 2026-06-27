import { NextResponse } from 'next/server'
import { getBookingById } from '@/lib/local/db'
import { getUserFromRequest, getUserById } from '@/lib/local/auth'
import { createPayment, paymobConfigured, paymobDiagnostics } from '@/lib/local/paymob'

// POST /api/local/bookings/:id/pay-init — start a REAL Paymob card payment for a booking.
// Returns the hosted-iframe URL the client opens (WebView/browser). The booking is marked
// paid only by the Paymob webhook (/api/paymob/webhook), never here.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}
const SERVICE_FEE_RATE = 0.1

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const me = await getUserFromRequest(req)
    if (!me) return NextResponse.json({ error: 'Please sign in to pay' }, { status: 401, headers: CORS })
    if (!paymobConfigured) {
      return NextResponse.json({ error: 'Online payment is not configured yet', diag: paymobDiagnostics() }, { status: 503, headers: CORS })
    }
    const bk = await getBookingById(id)
    if (!bk) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    if (bk.user_id !== me.id) return NextResponse.json({ error: 'Not allowed' }, { status: 403, headers: CORS })
    if (bk.paid_at) return NextResponse.json({ already_paid: true, booking: bk }, { headers: CORS })

    const subtotal = Math.round(bk.total_price)
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE)
    const amountCents = (subtotal + serviceFee) * 100 // EGP → piastres

    const u = await getUserById(me.id)
    const parts = String(u?.full_name || 'Guest User').trim().split(/\s+/)
    const billing = {
      first_name: parts[0] || 'Guest',
      last_name: parts.slice(1).join(' ') || 'User',
      email: u?.email || me.email,
      phone_number: 'NA',
    }
    const merchantOrderId = `${id}__${Date.now()}`
    const pay = await createPayment({ amountCents, currency: 'EGP', merchantOrderId, billing })

    return NextResponse.json({
      ok: true,
      iframe_url: pay.iframeUrl,
      payment_token: pay.paymentToken,
      order_id: pay.orderId,
      amount_cents: amountCents,
      currency: 'EGP',
      reference: bk.reservation_code,
    }, { headers: CORS })
  } catch (err) {
    console.error('pay-init failed:', err)
    return NextResponse.json({ error: 'Could not start payment', detail: String(err) }, { status: 500, headers: CORS })
  }
}
