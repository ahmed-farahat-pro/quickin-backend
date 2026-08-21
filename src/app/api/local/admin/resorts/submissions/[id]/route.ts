import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { approveResortSubmission, rejectResortSubmission } from '@/lib/local/resorts'

// Resolve one submission.
//   POST /api/local/admin/resorts/submissions/:id
//        { action: 'approve', name, region, merge_into_id? }  → create or merge, then relink
//        { action: 'reject', reason? }                        → dismiss; listings keep their text
//
// `name` is the CANONICAL spelling the admin types, which need not match what the
// host submitted — that is how 'amouge' becomes 'Amouage'. The submitted spelling is
// kept as an alias so the next host to type it auto-links instead of re-queueing.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'resorts')
  if ('error' in gate) return gate.error
  const { id } = await ctx.params
  const actor = gate.staff.legacy ? null : staffActor(gate.staff)

  try {
    const b = await req.json().catch(() => ({}))
    const action = String(b.action ?? '')

    if (action === 'reject') {
      const ok = await rejectResortSubmission(id, b.reason ?? null, actor)
      if (!ok) return NextResponse.json({ error: 'That submission has already been resolved' }, { status: 404, headers: NO_STORE })
      await logStaffAction({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        action: 'resort_reject',
        targetType: 'resort_submission',
        targetId: id,
        detail: { reason: b.reason ?? null },
        ip: clientIpOf(req),
      })
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }

    if (action !== 'approve') {
      return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400, headers: NO_STORE })
    }

    const result = await approveResortSubmission({
      submissionId: id,
      canonicalName: String(b.name ?? ''),
      region: String(b.region ?? ''),
      mergeIntoId: b.merge_into_id ?? b.mergeIntoId ?? null,
      actor,
    })
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'resort_merge',
      targetType: 'resort_submission',
      targetId: id,
      detail: {
        resort: result.resort?.name,
        aliasRecorded: result.aliasRecorded,
        listingsRelinked: result.listingsRelinked,
      },
      ip: clientIpOf(req),
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to resolve' },
      { status: 400, headers: NO_STORE }
    )
  }
}
