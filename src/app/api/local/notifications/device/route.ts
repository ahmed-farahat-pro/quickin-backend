import { NextResponse } from 'next/server'
import { registerDeviceToken } from '@/lib/local/notifications'
import { getUserFromRequest } from '@/lib/local/auth'

// Alias of /register-device — the Android app calls POST /api/local/notifications/device
// { fcm_token, token, platform }. Stores the device's FCM token for the signed-in user.
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
      'Access-Control-Allow-Methods': 'POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

async function handle(req: Request) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
  const b = await req.json().catch(() => ({}))
  const tok = b.fcm_token ?? b.token ?? b.fcmToken ?? b.device_token
  if (!tok) return NextResponse.json({ error: 'token is required' }, { status: 400, headers: CORS })
  await registerDeviceToken(user.id, String(tok), b.platform)
  return NextResponse.json({ ok: true }, { headers: CORS })
}

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (err) {
    return NextResponse.json({ error: 'Failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
export async function PATCH(req: Request) {
  try {
    return await handle(req)
  } catch (err) {
    return NextResponse.json({ error: 'Failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
