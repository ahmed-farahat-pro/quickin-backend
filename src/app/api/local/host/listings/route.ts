import { NextResponse } from 'next/server'
import { getHostListings } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// GET /api/local/host/listings → the signed-in host's own listings.
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
    const listings = await getHostListings(user.id)
    return NextResponse.json(listings, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load host listings', detail: String(err) }, { status: 500, headers: CORS })
  }
}
