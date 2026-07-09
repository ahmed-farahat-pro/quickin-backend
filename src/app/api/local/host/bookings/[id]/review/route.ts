import { NextResponse } from 'next/server'
import { hostReviewPayment } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// POST /api/local/host/bookings/:id/review {action:'accept'|'reject', reason?}
// The host reviews a booking's Instapay transfer screenshot. Accept → the booking
// is confirmed and marked paid; Reject → declined with a reason (the guest can then
// re-upload or dispute). Only the listing's host, only while the booking is pending.
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
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
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
    const raw = String(body.action ?? '')
    const action = /^acc/i.test(raw) ? 'accept' : /^rej|^dec/i.test(raw) ? 'reject' : null
    if (!action) {
      return NextResponse.json({ error: 'action must be "accept" or "reject"' }, { status: 400, headers: CORS })
    }
    const booking = await hostReviewPayment(id, user.id, action, body.reason ?? null)
    if (!booking) {
      return NextResponse.json(
        { error: 'Not allowed — you must be the host of this listing and the booking must still be pending review.' },
        { status: 403, headers: CORS }
      )
    }
    return NextResponse.json(booking, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to review payment', detail: String(err) }, { status: 500, headers: CORS })
  }
}
