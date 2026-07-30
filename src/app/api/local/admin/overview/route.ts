import { NextResponse } from 'next/server'
import { getAdminOverview } from '@/lib/local/admin'
import { requireStaff } from '@/lib/local/staff'

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
    const gate = await requireStaff(req, 'overview')
    if ('error' in gate) return gate.error
    const data = await getAdminOverview()
    return NextResponse.json(data, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load admin data', detail: String(err) }, { status: 500, headers: CORS })
  }
}
