import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { adminGetListingPhotos } from '@/lib/local/admin-listing-photos'

// GET /api/local/admin/listings/:id/photos
//   → { listing_id, title, photos: [{ id, url, kind: 'hosted'|'inline', position }] }
// The full gallery for the /ops photo viewer, in the host's order. Works for any
// listing state (pending, rejected, hidden) — the public detail route 404s those.
// Needs the `listings` module, the same as the list it is opened from. Not audited:
// these are the photos guests see, not identity documents.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store, private' }

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'listings')
  if ('error' in gate) return gate.error
  const { id } = await ctx.params
  try {
    const result = await adminGetListingPhotos(id)
    if (!result) return NextResponse.json({ error: 'Listing not found' }, { status: 404, headers: CORS })
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    console.error('admin listing photos GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}
