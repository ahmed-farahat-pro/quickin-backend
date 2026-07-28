import { NextResponse } from 'next/server'
import { updateStayGuideItem, deleteStayGuideItem } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// One stay-guide item — the listing's HOST only (enforced in the SQL).
//   PATCH  /api/local/bookings/:id/stay-guide/:itemId {title?, body?, url?, order?}
//          → edit / reorder. Only the keys present change; `kind` is immutable
//            (delete and re-add to change an item's type).
//   DELETE /api/local/bookings/:id/stay-guide/:itemId → remove.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

const NOT_HOST = 'Only the listing host can edit this stay guide item'

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => ({}))
    const patch: { title?: unknown; body?: unknown; url?: unknown; order?: unknown } = {}
    if ('title' in body) patch.title = body.title
    if ('body' in body || 'text' in body) patch.body = body.body ?? body.text
    if ('url' in body || 'link' in body) patch.url = body.url ?? body.link
    if ('order' in body) patch.order = body.order
    const item = await updateStayGuideItem(id, itemId, user.id, patch)
    if (!item) return NextResponse.json({ error: NOT_HOST }, { status: 403, headers: CORS })
    return NextResponse.json(item, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /Choose a type|Please|too large|too long|Add a title/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const deleted = await deleteStayGuideItem(id, itemId, user.id)
    if (!deleted) return NextResponse.json({ error: NOT_HOST }, { status: 403, headers: CORS })
    return NextResponse.json({ deleted: true }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to remove the item', detail: String(err) }, { status: 500, headers: CORS })
  }
}
