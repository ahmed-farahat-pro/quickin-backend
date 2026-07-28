import { NextResponse } from 'next/server'
import { getListingById, deleteListingImage, reorderListingImages, isListingInputError } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// One photo of a listing — host only, ownership enforced in SQL.
//   DELETE /api/local/listings/:id/images/:imageId          → remove the photo
//   PATCH  /api/local/listings/:id/images/:imageId { cover: true } → make it the cover
// Both re-queue the listing for admin review and return the FULL updated listing.
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
      'Access-Control-Allow-Methods': 'DELETE,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

const NOT_HOST = 'Only the listing host can edit this listing'

/** Anything a host can fix answers 400; everything else is a real 500. */
function failed(where: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`${where} failed:`, msg)
  return NextResponse.json({ error: msg }, { status: isListingInputError(err) ? 400 : 500, headers: CORS })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; imageId: string }> }) {
  try {
    const { id, imageId } = await params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const updated = await deleteListingImage(id, user.id, imageId)
    if (!updated) return NextResponse.json({ error: NOT_HOST }, { status: 403, headers: CORS })
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return failed('DELETE /api/local/listings/[id]/images/[imageId]', err)
  }
}

// "Set as cover" — the cover is simply the first photo, so this moves the chosen
// photo to the front and reuses the same ownership-checked reorder helper.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; imageId: string }> }) {
  try {
    const { id, imageId } = await params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    if (b.cover === false) {
      return NextResponse.json({ error: 'Set cover: true, or send the full order to /images' }, { status: 400, headers: CORS })
    }
    const listing = await getListingById(id)
    const ids = (listing?.listing_images ?? []).map((img) => img.id)
    if (!ids.includes(imageId)) {
      return NextResponse.json({ error: 'That photo is not on this listing' }, { status: 404, headers: CORS })
    }
    const updated = await reorderListingImages(id, user.id, [imageId, ...ids.filter((v) => v !== imageId)])
    if (!updated) return NextResponse.json({ error: NOT_HOST }, { status: 403, headers: CORS })
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return failed('PATCH /api/local/listings/[id]/images/[imageId]', err)
  }
}
