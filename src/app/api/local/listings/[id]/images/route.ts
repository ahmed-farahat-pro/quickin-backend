import { NextResponse } from 'next/server'
import { addListingImages, reorderListingImages, isListingInputError } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Photo management for a listing — host only, ownership enforced in SQL.
//   POST  /api/local/listings/:id/images { images: [...] } → append photos
//   PATCH /api/local/listings/:id/images { order: [imageId, ...] } → reorder (index 0 = cover)
// Both re-queue the listing for admin review (approval_status='pending',
// is_published=false) and return the FULL updated listing, so a client can show
// "under review" straight away without a refetch.
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
      'Access-Control-Allow-Methods': 'POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

const NOT_HOST = 'Only the listing host can edit this listing'

/** Anything a host can fix (a bad/oversized photo, too many photos, a bad order)
 *  answers 400; everything else is a real 500. */
function failed(where: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`${where} failed:`, msg)
  return NextResponse.json({ error: msg }, { status: isListingInputError(err) ? 400 : 500, headers: CORS })
}

// Append one or more photos. Accepts { images: [...] }, { urls: [...] } or a
// single { image } / { url } — each a data:image/… or https URL.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const urls = b.images ?? b.urls ?? b.photos ?? b.image ?? b.url
    if (urls === undefined) {
      return NextResponse.json({ error: 'Please attach at least one photo' }, { status: 400, headers: CORS })
    }
    const updated = await addListingImages(id, user.id, urls)
    if (!updated) return NextResponse.json({ error: NOT_HOST }, { status: 403, headers: CORS })
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return failed('POST /api/local/listings/[id]/images', err)
  }
}

// Reorder the whole photo set: { order: [imageId, ...] } (index 0 = cover).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const order = b.order ?? b.image_ids ?? b.imageIds ?? b.ids
    if (order === undefined) {
      return NextResponse.json({ error: 'Photo order must be a list of photo ids' }, { status: 400, headers: CORS })
    }
    const updated = await reorderListingImages(id, user.id, order)
    if (!updated) return NextResponse.json({ error: NOT_HOST }, { status: 403, headers: CORS })
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return failed('PATCH /api/local/listings/[id]/images', err)
  }
}
