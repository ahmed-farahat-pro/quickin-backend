import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminListIdChangeRequests, reviewIdChangeRequest } from '@/lib/local/id-changes'
import {
  isIdChangeError,
  normalizeIdChangeAction,
  normalizeIdChangeStatus,
  statusForIdChangeAction,
} from '@/lib/local/id-change-core'

// Admin (staff session + `id_changes` module):
//   GET  ?status=pending|approved|rejected → requests to change an account's ID number.
//        Returns the before/after numbers and the declared document type, NOT the
//        document images — those come one at a time from
//        /api/local/admin/documents/id_change_front|id_change_back/:id, which is audited.
//   POST { id, action: 'approve'|'reject', note? } → decide.
//
// Approving is the only path that writes users.id_document. The column is unreachable
// from the profile PATCH the apps use, so every value in it has been looked at by a
// person — which is the whole point of this queue.
//
// Gated on `id_changes` rather than `verifications` so correcting a number can be
// delegated without also handing over the decision that verifies an account and gates
// its listings.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'id_changes')
  if ('error' in gate) return gate.error
  try {
    const raw = new URL(req.url).searchParams.get('status')
    const filter = normalizeIdChangeStatus(raw ?? 'pending')
    return NextResponse.json(
      { requests: await adminListIdChangeRequests(filter), filter },
      { headers: CORS },
    )
  } catch (err) {
    console.error('admin id-changes GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'id_changes')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const id = body?.id
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400, headers: CORS })
    const action = normalizeIdChangeAction(body?.action)
    const note = body?.note ?? null

    const result = await reviewIdChangeRequest(id, action, note, staffActor(gate.staff))

    // The decided VALUE is in the audit detail on purpose: an approval rewrites a
    // person's identity number, and "what was it changed to, by whom" has to be
    // answerable later from the log alone.
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: `id_change_${statusForIdChangeAction(action)}`,
      targetType: 'user',
      targetId: result.userId,
      detail: { request_id: id, status: result.status, value: result.value, note },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true, status: result.status }, { headers: CORS })
  } catch (err) {
    if (isIdChangeError(err)) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400, headers: CORS })
    }
    console.error('admin id-changes POST:', err)
    return NextResponse.json({ error: 'Could not update' }, { status: 500, headers: CORS })
  }
}
