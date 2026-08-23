import { NextResponse } from 'next/server'
import { submitPaymentProof, getBookingProof } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Transfer screenshot for a booking.
//   POST /api/local/bookings/:id/payment-proof {image, method?}
//        → guest uploads / re-uploads a screenshot (payment 'submitted'; a
//          previously host-rejected booking reopens to 'pending').
//          `method` is 'instapay' | 'bank_transfer' — which destination the guest
//          says they sent to, so the reviewer knows which account to check.
//          Anything else, or omitted, is read as 'instapay' (older clients sent
//          no method at all).
//   GET  /api/local/bookings/:id/payment-proof
//        → the latest screenshot (base64), for the guest, the listing's host, or an admin.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => ({}))
    const image = body.image ?? body.payment_proof ?? body.proof
    if (!image) return NextResponse.json({ error: 'A screenshot is required' }, { status: 400, headers: CORS })
    // The method is validated inside submitPaymentProof against the shared
    // PAYMENT_METHODS vocabulary — passed through raw here on purpose, so there is
    // one place that decides what a valid method is.
    const booking = await submitPaymentProof(id, user.id, String(image), body.method)
    if (!booking) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    return NextResponse.json(booking, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /screenshot|too large|already paid/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const proof = await getBookingProof(id, user)
    if (!proof) return NextResponse.json({ error: 'No payment screenshot found' }, { status: 404, headers: CORS })
    return NextResponse.json(proof, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load screenshot', detail: String(err) }, { status: 500, headers: CORS })
  }
}
