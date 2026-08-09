import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import {
  fileDispute,
  listDisputesForGuest,
  getDisputeForGuest,
  listDisputeEvents,
  disputableBookingIds,
} from '@/lib/local/disputes'
import { isDisputeInputError, DISPUTE_CATEGORIES } from '@/lib/local/disputes-core'

// Guest disputes — raising an issue about a stay, and following it.
//
//   GET  /api/local/disputes                  → { disputes, categories }
//   GET  /api/local/disputes?id=…             → { dispute, events }
//   GET  /api/local/disputes?eligible=1       → { eligible: [bookingId], existing: {bookingId: status} }
//   POST /api/local/disputes { bookingId, category, description, photos? } → 201 { dispute }
//
// NOT `/bookings/:id/dispute` — that path is already the *payment* dispute
// ("the host rejected my proof and I did pay"), which is a different thing with
// a different lifecycle. Two features on one path would be a trap.
//
// `categories` ships with the list so a client never hardcodes it; the labels
// come from the shared disputes-core, so all three clients agree.
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
    const url = new URL(req.url)

    if (url.searchParams.get('eligible')) {
      return NextResponse.json(await disputableBookingIds(user.id), { headers: CORS })
    }

    const id = url.searchParams.get('id')
    if (id) {
      const dispute = await getDisputeForGuest(user.id, id)
      if (!dispute) return NextResponse.json({ error: 'Dispute not found' }, { status: 404, headers: CORS })
      return NextResponse.json({ dispute, events: await listDisputeEvents(id) }, { headers: CORS })
    }

    return NextResponse.json(
      { disputes: await listDisputesForGuest(user.id), categories: DISPUTE_CATEGORIES },
      { headers: CORS },
    )
  } catch (err) {
    console.error('GET /api/local/disputes:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => ({}))
    const dispute = await fileDispute({
      guestId: user.id,
      bookingId: String(body?.bookingId ?? body?.booking_id ?? ''),
      category: body?.category,
      description: body?.description,
      photos: body?.photos,
    })
    return NextResponse.json({ dispute }, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Everything the validators throw is written to be shown to the guest —
    // "please add a bit more detail", "this reservation was cancelled". A 500
    // here would hide the one thing they need to know to fix their filing.
    if (isDisputeInputError(err)) {
      return NextResponse.json({ error: msg }, { status: 400, headers: CORS })
    }
    console.error('POST /api/local/disputes:', err)
    return NextResponse.json({ error: 'Could not file this issue. Please try again.' }, { status: 500, headers: CORS })
  }
}
