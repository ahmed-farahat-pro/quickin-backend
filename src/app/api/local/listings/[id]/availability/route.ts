import { NextResponse } from 'next/server'
import { getListingAvailability, blockListingDates, unblockListingDates } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// A listing's calendar availability (live).
//   GET    /api/local/listings/:id/availability            → [{id,start,end,kind,note}] unavailable spans
//   POST   /api/local/listings/:id/availability {start,end,note?} → host blocks a range
//   DELETE /api/local/listings/:id/availability?blockId=…   → host removes a block
// GET is public (only dates — no guest data). POST/DELETE require the listing's host.
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ranges = await getListingAvailability(id)
    return NextResponse.json(ranges, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load availability', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const { id } = await params
    const b = await req.json().catch(() => ({}))
    const start = b.start ?? b.start_date ?? b.checkIn
    const end = b.end ?? b.end_date ?? b.checkOut
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null
    const block = await blockListingDates(id, user.id, start, end, note)
    if (!block) return NextResponse.json({ error: 'Only the listing host can block dates' }, { status: 403, headers: CORS })
    return NextResponse.json(block, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /Invalid|after/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    await params // listing id is implied by the block; ownership is enforced in the query
    const blockId = new URL(req.url).searchParams.get('blockId') ?? ''
    const ok = await unblockListingDates(blockId, user.id)
    if (!ok) return NextResponse.json({ error: 'Block not found (or not yours)' }, { status: 404, headers: CORS })
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to remove block', detail: String(err) }, { status: 500, headers: CORS })
  }
}
