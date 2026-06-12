import { NextResponse } from 'next/server'
import { getBookingById, getBookingMessages, createMessage } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Per-booking chat between the guest and the listing's host.
//   GET  /api/local/bookings/:id/messages           → the thread
//   POST /api/local/bookings/:id/messages {body}    → send a message
// Authorized: the booking's guest (user_id), the listing's host (host_id), or admin.
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

async function authorize(req: Request, bookingId: string) {
  const user = await getUserFromRequest(req)
  if (!user) return { error: NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS }) }
  const booking = await getBookingById(bookingId)
  if (!booking) return { error: NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS }) }
  const allowed = booking.user_id === user.id || booking.host_id === user.id || user.role === 'admin'
  if (!allowed) return { error: NextResponse.json({ error: 'Not allowed' }, { status: 403, headers: CORS }) }
  return { user, booking }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const a = await authorize(req, id)
    if (a.error) return a.error
    const messages = await getBookingMessages(id)
    return NextResponse.json(messages, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load messages', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const a = await authorize(req, id)
    if (a.error) return a.error
    const body = await req.json().catch(() => ({}))
    const text = String(body.body ?? body.message ?? '').trim()
    if (!text) return NextResponse.json({ error: 'Message cannot be empty' }, { status: 400, headers: CORS })
    const message = await createMessage(id, a.user!.id, text)
    return NextResponse.json(message, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: /empty|Invalid/i.test(msg) ? 400 : 500, headers: CORS })
  }
}
