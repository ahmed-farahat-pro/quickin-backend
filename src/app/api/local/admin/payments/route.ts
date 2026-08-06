import { NextResponse } from 'next/server'
import { adminListDisputes, adminResolveDispute } from '@/lib/local/db'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'

// Admin payment-dispute queue.
//   GET  /api/local/admin/payments                         → open disputes
//   POST /api/local/admin/payments {booking_id, action, note?}
//        action: 'approve' (confirm + mark paid) | 'uphold' (keep rejected)
// Admins only (role='admin').
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

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'payments')
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json(await adminListDisputes(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load disputes', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'payments')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => ({}))
    const bookingId = String(body.booking_id ?? body.bookingId ?? '')
    const raw = String(body.action ?? '')
    const action = /^app/i.test(raw) ? 'approve' : /^up|^rej/i.test(raw) ? 'uphold' : null
    if (!bookingId || !action) {
      return NextResponse.json({ error: 'booking_id and action ("approve"|"uphold") are required' }, { status: 400, headers: CORS })
    }
    const booking = await adminResolveDispute(bookingId, staffActor(gate.staff), action, body.note ?? null)
    if (!booking) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'dispute_resolved',
      targetType: 'booking',
      targetId: bookingId,
      detail: { outcome: action },
      ip: clientIpOf(req),
    })
    return NextResponse.json(booking, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to resolve dispute', detail: String(err) }, { status: 500, headers: CORS })
  }
}
