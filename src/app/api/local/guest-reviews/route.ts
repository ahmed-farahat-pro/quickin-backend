import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { createGuestReview, getGuestReviews, getReviewableGuests } from '@/lib/local/reviews'

// Two-way reviews: the host's review OF the guest.
//   GET  /api/local/guest-reviews?guest_id=...  → public reviews about a guest
//   GET  /api/local/guest-reviews               → (Bearer host) stays the host can review the guest for
//   POST /api/local/guest-reviews { booking_id, rating, comment }  → (Bearer host) leave/replace a guest review
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
    const guestId = new URL(req.url).searchParams.get('guest_id')
    if (guestId) {
      return NextResponse.json(await getGuestReviews(guestId), { headers: CORS })
    }
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    return NextResponse.json(await getReviewableGuests(user.id), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load guest reviews', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in to review a guest' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const review = await createGuestReview({
      hostId: user.id,
      bookingId: String(b.booking_id ?? b.bookingId ?? ''),
      rating: Number(b.rating),
      comment: b.comment,
    })
    return NextResponse.json(review, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to submit guest review'
    return NextResponse.json({ error: msg }, { status: 400, headers: CORS })
  }
}
