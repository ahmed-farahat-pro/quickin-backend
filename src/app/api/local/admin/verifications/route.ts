import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { getPendingVerifications, reviewVerification } from '@/lib/local/db'
import { isVerificationAction, normalizeVerificationFilter, statusForAction } from '@/lib/local/document-core'

// Admin (staff session + module permission):
//   GET  ?status=pending|verified|rejected|all → the ID verification queue.
//        Returns has_front/has_back/has_selfie booleans, NOT the images — those come
//        one at a time from /api/local/admin/documents/:kind/:id, which is audited.
//   POST { id, action: 'verify'|'reject'|'pending', note? } → decide, or reopen a
//        decided case. Writes users.verification_status (the source of truth every
//        badge reads) alongside the submission row, and records who decided.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'verifications')
  if ('error' in gate) return gate.error
  try {
    const url = new URL(req.url)
    const filter = normalizeVerificationFilter(url.searchParams.get('status'))
    return NextResponse.json(
      { verifications: await getPendingVerifications(filter), filter },
      { headers: CORS },
    )
  } catch (err) {
    console.error('admin verifications GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'verifications')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const id = body?.id
    const action = body?.action
    if (!id || !isVerificationAction(action)) {
      return NextResponse.json(
        { error: "id and action:'verify'|'reject'|'pending' required" },
        { status: 400, headers: CORS },
      )
    }
    const note = body?.note ?? null
    await reviewVerification(id, action, note, staffActor(gate.staff))
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: action === 'pending' ? 'verification_reopened' : `verification_${statusForAction(action)}`,
      targetType: 'verification',
      targetId: id,
      detail: { status: statusForAction(action), note },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true, status: statusForAction(action) }, { headers: CORS })
  } catch (err) {
    console.error('admin verifications POST:', err)
    const msg = err instanceof Error ? err.message : 'Could not update'
    return NextResponse.json({ error: msg }, { status: /not found/i.test(msg) ? 404 : 500, headers: CORS })
  }
}
