import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { reportFacets } from '@/lib/local/analytics'

// Options for the analytics filter bar — regions, active resorts, and the hosts who
// actually own a listing.
//   GET /api/local/admin/analytics/facets → { regions, resorts, hosts }
//
// Separate from the report routes because it changes rarely: the client fetches it
// once on mount, then re-runs only the report as filters change.
//
// NOTE: this sits under analytics/ alongside [kind], so Next matches the literal
// 'facets' segment before the dynamic one — no conflict.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'analytics')
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json(await reportFacets(), { headers: CORS })
  } catch (err) {
    console.error('admin analytics facets:', err)
    return NextResponse.json(
      { error: 'Failed to load filter options', detail: String(err) },
      { status: 500, headers: CORS }
    )
  }
}
