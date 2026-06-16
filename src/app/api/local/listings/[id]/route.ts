import { NextResponse } from 'next/server'
import { getListingById, updateListingPolicy } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// GET   /api/local/listings/:id → a single listing (no Supabase).
// PATCH /api/local/listings/:id { cancellation_policy } → host updates the policy.
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
      'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const listing = await getListingById(id)
    if (!listing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS })
    }
    return NextResponse.json(listing, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/listings/[id] failed:', err)
    return NextResponse.json(
      { error: 'Failed to load listing', detail: String(err) },
      { status: 500, headers: CORS }
    )
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const policy = b.cancellation_policy ?? b.cancellationPolicy
    if (typeof policy !== 'string') {
      return NextResponse.json({ error: 'cancellation_policy is required' }, { status: 400, headers: CORS })
    }
    const updated = await updateListingPolicy(id, user.id, policy)
    if (!updated) {
      return NextResponse.json({ error: 'Only the listing host can edit this listing' }, { status: 403, headers: CORS })
    }
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update listing', detail: String(err) }, { status: 500, headers: CORS })
  }
}
