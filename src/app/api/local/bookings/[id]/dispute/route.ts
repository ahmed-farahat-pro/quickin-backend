import { NextResponse } from 'next/server'
import { guestDisputePayment } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// POST /api/local/bookings/:id/dispute {note?}
// Guest contests a host-rejected payment ("I did pay"). Flags it for the admin
// dispute queue. Only the booking's guest, only when the latest proof is 'rejected'.
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
    const booking = await guestDisputePayment(id, user.id, body.note ?? null)
    if (!booking) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    return NextResponse.json(booking, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /rejected|dispute/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
