import { NextResponse } from 'next/server'
import { adminListDisputes, adminListPendingProofs, adminResolveDispute, adminReviewProof } from '@/lib/local/db'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { isPaymentReviewAction, normalizeRejectReason } from '@/lib/local/payment-flow-core'

// Admin payment-dispute queue (World 1 — cookie auth, non-Supabase).
//   GET  /api/local/admin/payments                         → open disputes
//   POST /api/local/admin/payments {booking_id, action, note?}
//        action: 'approve' (confirm + mark paid) | 'uphold' (keep rejected)
// Requires a staff session with the 'payments' module.
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
    // Two queues: screenshots waiting for a first decision, and escalated disputes.
    // The first didn't exist — a normal submission had no reviewer at all.
    const [pending, disputes] = await Promise.all([adminListPendingProofs(), adminListDisputes()])
    return NextResponse.json({ pending, disputes }, { headers: CORS })
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
    if (!bookingId) {
      return NextResponse.json({ error: 'booking_id is required' }, { status: 400, headers: CORS })
    }

    // Two vocabularies on one route: accept/reject decides a FRESH screenshot,
    // approve/uphold resolves an escalated dispute. They write different things, so
    // they stay distinct rather than being collapsed into one verb.
    if (isPaymentReviewAction(raw)) {
      const reason = normalizeRejectReason(body.reason ?? body.note)
      if (raw === 'reject' && !reason) {
        return NextResponse.json({ error: 'A reason is required when rejecting' }, { status: 400, headers: CORS })
      }
      const result = await adminReviewProof(bookingId, raw, reason, staffActor(gate.staff))
      if (!result) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
      await logStaffAction({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        action: raw === 'accept' ? 'payment_approved' : 'payment_rejected',
        targetType: 'booking',
        targetId: bookingId,
        detail: { reason },
        ip: clientIpOf(req),
      })
      return NextResponse.json({ ok: true, action: raw }, { headers: CORS })
    }

    const action = /^app/i.test(raw) ? 'approve' : /^up|^rej/i.test(raw) ? 'uphold' : null
    if (!action) {
      return NextResponse.json(
        { error: "action must be 'accept'|'reject' (new submission) or 'approve'|'uphold' (dispute)" },
        { status: 400, headers: CORS },
      )
    }
    const booking = await adminResolveDispute(bookingId, staffActor(gate.staff), action, body.note ?? null)
    if (!booking) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    // Approving a dispute marks a booking paid — a money decision, and one a guest or
    // host may later contest. It needs a name against it.
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'dispute_resolved',
      targetType: 'booking',
      targetId: bookingId,
      detail: { outcome: action, note: body.note ?? null },
      ip: clientIpOf(req),
    })
    return NextResponse.json(booking, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update payment', detail: String(err) }, { status: 500, headers: CORS })
  }
}
