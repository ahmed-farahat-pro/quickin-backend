import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import {
  getWishlist,
  getWishlistIds,
  toggleWishlist,
  addToWishlist,
  removeFromWishlist,
  type WishItemType,
} from '@/lib/local/wishlist'

// GET    /api/local/wishlist                     → { listings, services, listingIds, serviceIds }
// POST   /api/local/wishlist { item_type, item_id, action? }  → add | remove | toggle (default)
// DELETE /api/local/wishlist { item_type, item_id }           → remove
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
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

const typeOf = (v: unknown): WishItemType => (v === 'service' ? 'service' : 'listing')

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const [wl, ids] = await Promise.all([getWishlist(user.id), getWishlistIds(user.id)])
    return NextResponse.json({ ...wl, ...ids }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load wishlist', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in to save favorites' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const itemType = typeOf(b.item_type ?? b.itemType)
    const itemId = String(b.item_id ?? b.itemId ?? '')
    if (!itemId) return NextResponse.json({ error: 'item_id is required' }, { status: 400, headers: CORS })
    const action = String(b.action ?? 'toggle')
    if (action === 'add') {
      await addToWishlist(user.id, itemType, itemId)
      return NextResponse.json({ saved: true }, { headers: CORS })
    }
    if (action === 'remove') {
      await removeFromWishlist(user.id, itemType, itemId)
      return NextResponse.json({ saved: false }, { headers: CORS })
    }
    const saved = await toggleWishlist(user.id, itemType, itemId)
    return NextResponse.json({ saved }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update wishlist', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const itemType = typeOf(b.item_type ?? b.itemType)
    const itemId = String(b.item_id ?? b.itemId ?? '')
    if (!itemId) return NextResponse.json({ error: 'item_id is required' }, { status: 400, headers: CORS })
    await removeFromWishlist(user.id, itemType, itemId)
    return NextResponse.json({ saved: false }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to remove from wishlist', detail: String(err) }, { status: 500, headers: CORS })
  }
}
