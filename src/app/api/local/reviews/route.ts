import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { createReview, getListingReviews, getReviewableBookings } from '@/lib/local/reviews'

// GET  /api/local/reviews?listing_id=...  → public reviews for a listing
// GET  /api/local/reviews                 → (Bearer) the signed-in guest's reviewable stays
// POST /api/local/reviews { booking_id, rating, comment }  → (Bearer) leave/replace a review
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
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const listingId = new URL(req.url).searchParams.get('listing_id')
    if (listingId) {
      return NextResponse.json(await getListingReviews(listingId), { headers: CORS })
    }
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    return NextResponse.json(await getReviewableBookings(user.id), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load reviews', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in to leave a review' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const review = await createReview({
      userId: user.id,
      bookingId: String(b.booking_id ?? b.bookingId ?? ''),
      rating: Number(b.rating),
      comment: b.comment,
    })
    return NextResponse.json(review, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to submit review'
    return NextResponse.json({ error: msg }, { status: 400, headers: CORS })
  }
}
