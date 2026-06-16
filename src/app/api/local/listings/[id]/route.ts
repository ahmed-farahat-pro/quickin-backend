import { NextResponse } from 'next/server'
import { getListingById, updateListingPolicy, setListingOwnershipDoc, updateListingDiscounts } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// GET   /api/local/listings/:id → a single listing (no Supabase).
// PATCH /api/local/listings/:id { cancellation_policy } → host updates the policy.
//        ... { ownership_doc } → host (re)submits the ownership doc → re-queues for review.
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

    // Host (re)submits ownership proof → re-queues the listing for review.
    const doc = b.ownership_doc ?? b.ownershipDoc
    if (typeof doc === 'string' && doc.trim()) {
      const updated = await setListingOwnershipDoc(id, user.id, doc)
      if (!updated) return NextResponse.json({ error: 'Only the listing host can edit this listing' }, { status: 403, headers: CORS })
      return NextResponse.json(updated, { headers: CORS })
    }

    // Host updates length-of-stay discounts (% off for ≥7 / ≥28 nights).
    const weekly = b.weekly_discount ?? b.weeklyDiscount
    const monthly = b.monthly_discount ?? b.monthlyDiscount
    if (weekly !== undefined || monthly !== undefined) {
      const updated = await updateListingDiscounts(id, user.id, Number(weekly ?? 0), Number(monthly ?? 0))
      if (!updated) return NextResponse.json({ error: 'Only the listing host can edit this listing' }, { status: 403, headers: CORS })
      return NextResponse.json(updated, { headers: CORS })
    }

    const policy = b.cancellation_policy ?? b.cancellationPolicy
    if (typeof policy !== 'string') {
      return NextResponse.json({ error: 'cancellation_policy, ownership_doc or discounts required' }, { status: 400, headers: CORS })
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
