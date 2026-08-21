import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf, staffActor } from '@/lib/local/staff'
import { adminListDisputes, adminGetDispute, applyDisputeTransition, listDisputeEvents } from '@/lib/local/disputes'
import { normalizeStatus, canTransition, transitionError, DISPUTE_STATUSES } from '@/lib/local/disputes-core'

// Guest disputes (F6) — the /ops queue.
//   GET  /api/local/admin/disputes?status=needs_action|open|in_review|resolved|closed|all
//   GET  /api/local/admin/disputes?id=…    → { dispute, events }
//   POST /api/local/admin/disputes { id, status, note?, resolution? }
//
// A status change is a compare-and-set against the status the operator was
// looking at, so two people working the queue at once can't both act on a stale
// screen. Every change writes a dispute_events row — that history is the
// acceptance criterion, not a nice-to-have — and a staff_audit_log row.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'disputes')
  if ('error' in gate) return gate.error
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (id) {
      const dispute = await adminGetDispute(id)
      if (!dispute) return NextResponse.json({ error: 'Dispute not found' }, { status: 404, headers: CORS })
      return NextResponse.json({ dispute, events: await listDisputeEvents(id) }, { headers: CORS })
    }
    const status = url.searchParams.get('status') || 'needs_action'
    return NextResponse.json({ disputes: await adminListDisputes(status), status }, { headers: CORS })
  } catch (err) {
    console.error('admin disputes GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'disputes')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const id = String(body?.id ?? '')
    const to = String(body?.status ?? '')
    if (!id || !(DISPUTE_STATUSES as readonly string[]).includes(to)) {
      return NextResponse.json(
        { error: `id and status (${DISPUTE_STATUSES.join(' | ')}) required` },
        { status: 400, headers: CORS },
      )
    }

    const current = await adminGetDispute(id)
    if (!current) return NextResponse.json({ error: 'Dispute not found' }, { status: 404, headers: CORS })

    const from = normalizeStatus(current.status)
    if (!canTransition(from, to)) {
      return NextResponse.json({ error: transitionError(from, to) }, { status: 400, headers: CORS })
    }

    const result = await applyDisputeTransition({
      disputeId: id,
      to: normalizeStatus(to),
      expectedFrom: from,
      note: body?.note,
      resolution: body?.resolution,
      actor: staffActor(gate.staff),
      actorName: gate.staff.fullName || gate.staff.email,
    })
    if (!result.ok) {
      // Someone else moved it between the read above and the write. 409, because
      // retrying after a refresh is the correct response.
      return NextResponse.json({ error: result.conflict }, { status: 409, headers: CORS })
    }

    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'dispute_status_changed',
      targetType: 'dispute',
      targetId: id,
      detail: { from, to, hasNote: Boolean(body?.note) },
      ip: clientIpOf(req),
    })

    const dispute = await adminGetDispute(id)
    return NextResponse.json({ ok: true, dispute, events: await listDisputeEvents(id) }, { headers: CORS })
  } catch (err) {
    console.error('admin disputes POST:', err)
    return NextResponse.json({ error: 'Action failed' }, { status: 500, headers: CORS })
  }
}
