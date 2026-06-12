import { NextResponse } from 'next/server'
import { getBookingById, setBookingStatus } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Single reservation.
//   GET   /api/local/bookings/:id           → details (booking owner OR the listing's host)
//   PATCH /api/local/bookings/:id {status}  → host confirms/rejects a pending booking
//      status: "confirm" | "reject" (or "confirmed" | "rejected")
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
      'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const booking = await getBookingById(id)
    if (!booking) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    if (booking.user_id !== user.id && booking.host_id !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403, headers: CORS })
    }
    return NextResponse.json(booking, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load reservation', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => ({}))
    const action = String(body.status ?? body.action ?? '')
    const status = /^confirm/i.test(action) ? 'confirmed' : /^reject/i.test(action) ? 'rejected' : null
    if (!status) {
      return NextResponse.json({ error: 'status must be "confirm" or "reject"' }, { status: 400, headers: CORS })
    }
    const updated = await setBookingStatus(id, user.id, status)
    if (!updated) {
      return NextResponse.json(
        { error: 'Not allowed — you must be the host of this listing and the booking must still be pending.' },
        { status: 403, headers: CORS }
      )
    }
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update reservation', detail: String(err) }, { status: 500, headers: CORS })
  }
}
