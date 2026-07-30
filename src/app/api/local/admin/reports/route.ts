import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { listReports, resolveReport } from '@/lib/local/trust'

// Admin reports triage.
//   GET  /api/local/admin/reports?status=open                 → reports (optionally filtered)
//   POST /api/local/admin/reports { report_id, action }       → action: "resolve" | "dismiss"
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
  try {
    const gate = await requireStaff(req, 'reports')
    if ('error' in gate) return gate.error
    const status = new URL(req.url).searchParams.get('status') ?? undefined
    return NextResponse.json(await listReports(status), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load reports', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const gate = await requireStaff(req, 'reports')
    if ('error' in gate) return gate.error
    const b = await req.json().catch(() => ({}))
    const reportId = String(b.report_id ?? b.reportId ?? '')
    const action = String(b.action ?? '')
    const status = /^resolve/i.test(action) ? 'resolved' : /^dismiss/i.test(action) ? 'dismissed' : null
    if (!status) return NextResponse.json({ error: 'action must be "resolve" or "dismiss"' }, { status: 400, headers: CORS })
    const ok = await resolveReport(reportId, status)
    if (!ok) return NextResponse.json({ error: 'Report not found' }, { status: 404, headers: CORS })
    return NextResponse.json({ ok: true, status }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update report', detail: String(err) }, { status: 500, headers: CORS })
  }
}
