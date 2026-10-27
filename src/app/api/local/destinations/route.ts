import { NextResponse } from 'next/server'
import { getDestinations } from '@/lib/local/db'

// GET /api/local/destinations → the explore region rail: every region in rail
// order with its sub-areas (catalog resorts) and live counts, e.g.
//   [{ name: 'North Coast', slug: 'north-coast', name_ar: '…', icon: 'waves', count: 12,
//      sub_areas: [{ id, slug: 'marassi', name: 'Marassi', name_ar: 'مراسي',
//                    km_marker: null, location_note: null, count: 3 }, …] }, …]
// A region with no sub_areas hides the chip row. Pick a chip → the feed with
// `?region=<name>&area=<sub-area slug>`. /api/local/regions stays for old clients.
//
// Public, cached briefly at the edge: the taxonomy changes rarely and the counts
// tolerate a minute of staleness.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600',
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
    return NextResponse.json(await getDestinations(), { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/destinations failed:', err)
    return NextResponse.json(
      { error: 'Failed to load destinations', detail: String(err) },
      { status: 500, headers: { ...CORS, 'Cache-Control': 'no-store' } }
    )
  }
}
