import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { listPendingVerifications, setVerification } from '@/lib/local/trust'

// Admin verification queue.
//   GET  /api/local/admin/verifications                       → pending submissions (with doc)
//   POST /api/local/admin/verifications { user_id, action }   → action: "approve" | "reject"
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
    return NextResponse.json(await listPendingVerifications(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load verifications', detail: String(err) }, { status: 500, headers: CORS })
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
    const state = await setVerification(userId, /^approve$/i.test(action))
    if (!state) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: CORS })
    return NextResponse.json(state, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update verification', detail: String(err) }, { status: 500, headers: CORS })
  }
}
