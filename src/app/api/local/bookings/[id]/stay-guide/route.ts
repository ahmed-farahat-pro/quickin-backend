import { NextResponse } from 'next/server'
import { listStayGuide, addStayGuideItem } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Host-authored stay guide for a reservation (info blocks, photos, QR links to
// places, attachments). The guest sees the same items on the public stay pass.
//   GET  /api/local/bookings/:id/stay-guide  → items, for the guest, the
//        listing's host, or an admin.
//   POST /api/local/bookings/:id/stay-guide {kind, title?, body?, url?, order?}
//        → the listing's HOST only, and only once the booking is confirmed.
//        kind ∈ info | photo | place_qr | attachment.
// Authorization is enforced inside the SQL (the booking must belong to a listing
// this host owns) — a client-supplied host id can never widen it.
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

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const items = await listStayGuide(id, user)
    if (!items) return NextResponse.json({ error: 'Not allowed' }, { status: 403, headers: CORS })
    return NextResponse.json(items, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load the stay guide', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => ({}))
    const item = await addStayGuideItem(id, user.id, {
      kind: body.kind ?? body.type,
      title: body.title,
      body: body.body ?? body.text,
      url: body.url ?? body.link ?? body.image,
      order: body.order,
    })
    if (!item) {
      return NextResponse.json(
        { error: 'Only the listing host can add stay guide items, and only once the reservation is confirmed.' },
        { status: 403, headers: CORS }
      )
    }
    return NextResponse.json(item, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /Choose a type|Please|too large|too long|Add a title/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
