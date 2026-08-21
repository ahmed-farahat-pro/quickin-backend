import { NextResponse } from 'next/server'
import { getWishlistListings, toggleWishlist } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Wishlist API (no Supabase). Auth via Bearer token (mobile) or qk_token cookie (web).
//   GET  /api/local/wishlists              → { listings } the signed-in user's saved listings
//   POST /api/local/wishlists { listingId } → { saved } toggle a listing in the wishlist
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const listings = await getWishlistListings(user.id)
    return NextResponse.json({ listings }, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/wishlists failed:', err)
    return NextResponse.json({ error: 'Failed to load wishlist', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in to save listings' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: CORS })
    const listingId = body.listingId || body.listing_id
    if (!listingId) return NextResponse.json({ error: 'listingId is required' }, { status: 400, headers: CORS })
    const result = await toggleWishlist(user.id, String(listingId))
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('POST /api/local/wishlists failed:', msg)
    const status = /Invalid/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
