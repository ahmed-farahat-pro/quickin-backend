import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
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
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })
    const status = new URL(req.url).searchParams.get('status') ?? undefined
    return NextResponse.json(await listReports(status), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load reports', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })
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
