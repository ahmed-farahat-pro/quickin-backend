import { NextResponse } from 'next/server'
import { getAdminOverview } from '@/lib/local/admin'
import { getUserFromRequest } from '@/lib/local/auth'

// GET /api/local/admin/overview → everything (users, listings, bookings, services,
// service-requests + counts). Admin only.
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
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })
    const data = await getAdminOverview()
    return NextResponse.json(data, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load admin data', detail: String(err) }, { status: 500, headers: CORS })
  }
}
