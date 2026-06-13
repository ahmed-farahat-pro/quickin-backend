import { NextResponse } from 'next/server'
import { getRegionCounts } from '@/lib/local/db'

// GET /api/local/regions → the canonical search regions with live listing counts,
// e.g. [{ region: 'North Coast', count: 1 }, ...]. Powers the explore "region
// chips" so every client shows the same areas without hardcoding them.
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

export async function GET() {
  try {
    const regions = await getRegionCounts()
    return NextResponse.json(regions, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/regions failed:', err)
    return NextResponse.json({ error: 'Failed to load regions', detail: String(err) }, { status: 500, headers: CORS })
  }
}
