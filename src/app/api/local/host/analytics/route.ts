import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getHostAnalytics } from '@/lib/local/money'

// GET /api/local/host/analytics (Bearer) → the host's performance dashboard.
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
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.id === 'admin') {
      return NextResponse.json(await getHostAnalytics('00000000-0000-0000-0000-000000000000'), { headers: CORS })
    }
    return NextResponse.json(await getHostAnalytics(user.id), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load analytics', detail: String(err) }, { status: 500, headers: CORS })
  }
}
