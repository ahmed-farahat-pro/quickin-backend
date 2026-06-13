import { NextResponse } from 'next/server'
import { registerDeviceToken } from '@/lib/local/notifications'
import { getUserFromRequest } from '@/lib/local/auth'

// POST /api/local/notifications/register-device { token, platform } → store an FCM
// device token for the signed-in user (used later to deliver push via Firebase).
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
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    if (!b.token) return NextResponse.json({ error: 'token is required' }, { status: 400, headers: CORS })
    await registerDeviceToken(user.id, String(b.token), b.platform)
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
