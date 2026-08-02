import { NextResponse } from 'next/server'
import { listActiveResorts } from '@/lib/local/resorts'

// The resort catalog the host listing form offers in its dropdown.
//   GET /api/local/resorts           → every active resort, grouped-ready (region, name)
//   GET /api/local/resorts?region=X  → just that region's
//
// Public and unauthenticated, exactly like /api/local/regions: it is a list of
// compound names, and the host form needs it before the user has committed to
// anything. Inactive resorts are excluded — they stay valid on existing listings but
// are no longer offered.
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
    const region = new URL(req.url).searchParams.get('region')
    return NextResponse.json({ resorts: await listActiveResorts(region) }, { headers: CORS })
  } catch (err) {
    // A missing catalog must not break the listing form — degrade to "no options",
    // which the form renders as the free-text path only.
    console.error('resorts GET:', err)
    return NextResponse.json({ resorts: [] }, { headers: CORS })
  }
}
