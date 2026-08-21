import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { getPendingHostApplications, reviewHostApplication } from '@/lib/local/db'

// Admin (staff session + 'applications' module): GET [?status=]  → host applications (default: pending).
//                    POST { id, action: 'approve'|'reject', note? } → decide.
// Approving flips users.is_host (transactionally) and notifies the applicant.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'applications')
  if ('error' in gate) return gate.error
  try {
    const status = new URL(req.url).searchParams.get('status') || 'pending'
    return NextResponse.json({ applications: await getPendingHostApplications(status) }, { headers: CORS })
  } catch (err) {
    console.error('admin host-applications GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'applications')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const id = body?.id
    const action = body?.action === 'approve' ? 'approve' : body?.action === 'reject' ? 'reject' : null
    if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400, headers: CORS })
    const note = body?.note ?? null
    await reviewHostApplication(id, action, note, staffActor(gate.staff))
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: action === 'approve' ? 'host_application_approved' : 'host_application_rejected',
      targetType: 'host_application',
      targetId: id,
      detail: { note },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('admin host-applications POST:', err)
    return NextResponse.json({ error: 'Could not update' }, { status: 500, headers: CORS })
  }
}
