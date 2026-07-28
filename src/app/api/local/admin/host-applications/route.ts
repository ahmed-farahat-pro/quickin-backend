import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { listHostApplications, reviewHostApplication } from '@/lib/local/db'

// Admin host-application queue.
//   GET  /api/local/admin/host-applications[?status=pending|approved|rejected|all]
//        → { applications: [ … ] }  (defaults to pending)
//   POST /api/local/admin/host-applications { user_id, action, note? }
//        → action: "approve" (flips users.is_host) | "reject". Both notify the applicant.
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
    const status = new URL(req.url).searchParams.get('status') || 'pending'
    return NextResponse.json({ applications: await listHostApplications(status) }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load host applications', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const userId = String(b.user_id ?? b.userId ?? '')
    const action = String(b.action ?? '')
    if (!/^(approve|reject)$/i.test(action)) {
      return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400, headers: CORS })
    }
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null
    const application = await reviewHostApplication(userId, /^approve$/i.test(action) ? 'approve' : 'reject', note)
    if (!application) return NextResponse.json({ error: 'Application not found' }, { status: 404, headers: CORS })
    return NextResponse.json({ ok: true, application }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update host application', detail: String(err) }, { status: 500, headers: CORS })
  }
}
