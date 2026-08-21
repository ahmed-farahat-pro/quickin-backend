import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminListReports, adminResolveReport } from '@/lib/local/db'

// Abuse-report triage (F4).
//   GET  /api/local/admin/reports?status=open|resolved|dismissed|all
//   POST /api/local/admin/reports { id, action:'resolve'|'dismiss' }
//
// The backend project has had this API since the trust work; /ops lives here and had
// no route and no screen, so the `reports` module gated something the console could
// never reach and no filed report had ever been read by anyone.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'reports')
  if ('error' in gate) return gate.error
  try {
    const status = new URL(req.url).searchParams.get('status') || 'open'
    return NextResponse.json({ reports: await adminListReports(status), status }, { headers: CORS })
  } catch (err) {
    console.error('admin reports GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'reports')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const id = String(body?.id ?? '')
    const raw = String(body?.action ?? '')
    const status = /^resolve/i.test(raw) ? 'resolved' : /^dismiss/i.test(raw) ? 'dismissed' : null
    if (!id || !status) {
      return NextResponse.json({ error: "id and action:'resolve'|'dismiss' required" }, { status: 400, headers: CORS })
    }
    const ok = await adminResolveReport(id, status)
    if (!ok) return NextResponse.json({ error: 'Report not found' }, { status: 404, headers: CORS })
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: status === 'resolved' ? 'report_resolved' : 'report_dismissed',
      targetType: 'report',
      targetId: id,
      detail: { status },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true, status }, { headers: CORS })
  } catch (err) {
    console.error('admin reports POST:', err)
    return NextResponse.json({ error: 'Could not update the report' }, { status: 500, headers: CORS })
  }
}
