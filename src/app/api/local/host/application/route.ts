import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getHostApplication, getHostState } from '@/lib/local/db'

// GET /api/local/host/application — the signed-in user's host application.
//   → { host_status: 'none'|'pending'|'rejected'|'approved', application: {…}|null }
// host_status is derived (users.is_host wins, so legacy hosts read as approved).
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
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const me = await getUserFromRequest(req)
    if (!me || me.id === 'admin') {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    }
    const [state, application] = await Promise.all([getHostState(me.id), getHostApplication(me.id)])
    return NextResponse.json({ host_status: state.host_status, application }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load application', detail: String(err) }, { status: 500, headers: CORS })
  }
}
