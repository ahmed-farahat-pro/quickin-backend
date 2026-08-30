import { NextResponse } from 'next/server'
import { adminListRefunds, adminMarkRefunded } from '@/lib/local/db'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'

// The refunds queue — who is still owed money on a cancelled reservation, and the
// one action that closes a row.
//
//   GET  /api/local/admin/refunds                                → { due, settled }
//   POST /api/local/admin/refunds {booking_id, reference?}        → marks it SENT
//
// There is no payment gateway: a cancellation records what the guest is owed and a
// human transfers it. This route is the record of that transfer, which is why the
// POST is audited — it is a money decision with a name against it, and the guest is
// notified the moment it lands.
//
// Gated on the 'payments' module rather than a new one: the same person who reviews
// transfer screenshots and disputes moves the money back, and a fresh module would
// need granting to every existing moderator before anyone could see the queue.
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
    const { due, settled } = await adminListRefunds()
    return NextResponse.json({ due, settled }, { headers: CORS })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load refunds', detail: String(err) },
      { status: 500, headers: CORS },
    )
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'payments')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => ({}))
    const bookingId = String(body.booking_id ?? body.bookingId ?? '')
    if (!bookingId) {
      return NextResponse.json({ error: 'booking_id is required' }, { status: 400, headers: CORS })
    }
    const reference = body.reference ?? body.ref ?? null
    const booking = await adminMarkRefunded(bookingId, staffActor(gate.staff), reference)
    // Null covers three cases that look identical from here and all mean the same
    // thing to the operator: no such booking, not cancelled, or already settled by
    // whoever else has the queue open. 409 rather than 404 so a double-click reads
    // as "someone got there first" instead of "this row is gone".
    if (!booking) {
      return NextResponse.json(
        { error: 'Nothing to refund — the reservation is not cancelled, owes nothing, or was already refunded.' },
        { status: 409, headers: CORS },
      )
    }
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'refund_sent',
      targetType: 'booking',
      targetId: bookingId,
      detail: { amount: booking.refund_amount, percent: booking.refund_percent, reference: reference ?? null },
      ip: clientIpOf(req),
    })
    return NextResponse.json(booking, { headers: CORS })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to mark the refund as sent', detail: String(err) },
      { status: 500, headers: CORS },
    )
  }
}
