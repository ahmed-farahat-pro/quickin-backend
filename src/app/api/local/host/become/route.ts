import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getHostState } from '@/lib/local/db'

// POST /api/local/host/become — GONE. Hosting is no longer granted instantly: the
// user submits an application (POST /api/local/host/apply) that an admin approves,
// which is the only thing that flips users.is_host. The route is kept so old app
// builds get a clear error instead of a silent fake "you are a host now".
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
    const me = await getUserFromRequest(req)
    if (!me || me.id === 'admin') {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    }
    const { host_status } = await getHostState(me.id)
    return NextResponse.json(
      { error: 'Use /api/local/host/apply', host_status },
      { status: 410, headers: CORS }
    )
  } catch (err) {
    console.error('become host failed:', err)
    return NextResponse.json({ error: 'Use /api/local/host/apply', detail: String(err) }, { status: 410, headers: CORS })
  }
}
