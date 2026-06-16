import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getHostEarnings } from '@/lib/local/money'

// GET /api/local/host/earnings (Bearer) → the host's mock earnings + payout summary.
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
      return NextResponse.json({ currency: 'EGP', totalEarned: 0, paidOut: 0, pending: 0, bookingsCount: 0, commissionRate: 0.1, recent: [] }, { headers: CORS })
    }
    return NextResponse.json(await getHostEarnings(user.id), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load earnings', detail: String(err) }, { status: 500, headers: CORS })
  }
}
