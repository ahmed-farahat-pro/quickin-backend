import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { listPendingListings, setListingApproval } from '@/lib/local/db'

// Admin listing-moderation queue.
//   GET  /api/local/admin/listings                       → pending listings (with ownership_doc + host email)
//   POST /api/local/admin/listings { listing_id, action } → action: "approve" | "reject"
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
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })
    return NextResponse.json(await listPendingListings(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load pending listings', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const listingId = String(b.listing_id ?? b.listingId ?? '')
    const action = String(b.action ?? '')
    if (!/^(approve|reject)$/i.test(action)) {
      return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400, headers: CORS })
    }
    const updated = await setListingApproval(listingId, /^approve$/i.test(action))
    if (!updated) return NextResponse.json({ error: 'Listing not found' }, { status: 404, headers: CORS })
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update listing', detail: String(err) }, { status: 500, headers: CORS })
  }
}
