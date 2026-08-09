import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { pendingWarningFor, acknowledgeWarning } from '@/lib/local/moderation'

// The policy warning a moderator issued, and the user's acknowledgement of it.
//
// Under the chosen design nothing else notifies the user — no email, no push — so
// this endpoint IS the delivery mechanism: the chat send answers 409 with the
// warning, the client shows it, and the user clears it here. Until they do, every
// chat send keeps answering 409.
//
//   GET  /api/local/policy-warning        → { warning: { id, message } | null }
//   POST /api/local/policy-warning { id } → { ok: true }
//
// GET exists so a client can show the warning on entering chat rather than making
// the user type a message first and have it bounce.
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
    return NextResponse.json({ warning: await pendingWarningFor(user.id) }, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/policy-warning:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => ({}))
    const id = String(body?.id ?? '')
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400, headers: CORS })
    // Scoped to the caller's own row inside acknowledgeWarning, so an id from
    // another user's warning clears nothing. `false` means it was already
    // acknowledged (a double-tap), which is not an error worth showing.
    await acknowledgeWarning(user.id, id)
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('POST /api/local/policy-warning:', err)
    return NextResponse.json({ error: 'Failed to acknowledge' }, { status: 500, headers: CORS })
  }
}
