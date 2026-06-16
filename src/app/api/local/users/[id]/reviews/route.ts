import { NextResponse } from 'next/server'
import { getHostReviews } from '@/lib/local/reviews'

// GET /api/local/users/:id/reviews → recent reviews across this host's listings.
// Public — powers the "reviews about this host" section on the host profile page.
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    return NextResponse.json(await getHostReviews(id), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load host reviews', detail: String(err) }, { status: 500, headers: CORS })
  }
}
