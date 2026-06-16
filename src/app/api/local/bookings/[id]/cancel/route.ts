import { NextResponse } from 'next/server'
import { getCancellationQuote, cancelBooking } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Guest cancellation (mock refund per the listing's cancellation policy).
//   GET  /api/local/bookings/:id/cancel  → quote { policy, refundPercent, refundAmount, … } (no mutation)
//   POST /api/local/bookings/:id/cancel  → cancels the booking, returns { booking, refund }
// Only the booking's guest may call these.
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

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const quote = await getCancellationQuote(id, user.id)
    if (!quote) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    return NextResponse.json(quote, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load cancellation quote', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const result = await cancelBooking(id, user.id)
    if (!result) {
      return NextResponse.json(
        { error: 'This reservation can’t be cancelled (not yours, or already cancelled/completed).' },
        { status: 400, headers: CORS }
      )
    }
    return NextResponse.json({ booking: result.booking, refund: result.quote }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to cancel reservation', detail: String(err) }, { status: 500, headers: CORS })
  }
}
