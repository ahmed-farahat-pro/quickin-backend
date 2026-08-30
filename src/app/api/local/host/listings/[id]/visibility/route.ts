import { NextResponse } from 'next/server'
import { hostSetListingPublished } from '@/lib/local/db'
import { reactivateBlockMessage } from '@/lib/local/host-visibility-core'
import { getUserFromRequest } from '@/lib/local/auth'

// PATCH /api/local/host/listings/:id/visibility  { is_published: boolean }
//
// The host takes their own listing off the market, or puts it back. This is
// QuickIn's answer to "delete my listing" — there is no host-facing DELETE and
// there will not be one, because bookings, reviews, payments, messages and the
// stay guide all hang off the listing id and deleting the row would cascade a
// guest's completed stay away with it.
//
// Deactivating flips `is_published` false (search drops it, createBooking refuses
// it, the public detail route 404s) and DECLINES every booking request still
// waiting on this host — the response says how many, and the clients warn with
// the count first. Reactivating clears only the host's own flag; if an account
// block, the identity gate or the review queue is also holding the listing down,
// `blocked_by` names it and the listing stays hidden until that clears too.
//
// See src/lib/local/host-visibility-core.ts for the full four-party rule.
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
      'Access-Control-Allow-Methods': 'PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

/** Accept the API's snake_case and the camelCase the mobile encoders emit, the
 *  same way PATCH /api/local/listings/:id does. `active` is allowed because the
 *  admin route already spells the same idea that way. */
function readNext(body: Record<string, unknown>): boolean | null {
  for (const key of ['is_published', 'isPublished', 'active', 'published']) {
    const v = body[key]
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 'false') return v === 'true'
  }
  return null
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const next = readNext(body)
    if (next === null) {
      return NextResponse.json(
        { error: 'Send { "is_published": true } to reactivate or { "is_published": false } to deactivate' },
        { status: 400, headers: CORS },
      )
    }

    // Ownership is enforced inside the SQL (host_id = the signed-in user), so a
    // listing that isn't theirs simply matches no row.
    const result = await hostSetListingPublished(id, user.id, next)
    if (!result) {
      return NextResponse.json(
        { error: 'Only the listing host can change this listing' },
        { status: 403, headers: CORS },
      )
    }

    return NextResponse.json(
      {
        ...result,
        // Pre-composed so web, iOS and Android cannot word the same outcome three
        // different ways. Empty when the listing really did go live.
        blocked_message: reactivateBlockMessage(result.blocked_by),
      },
      { headers: CORS },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('PATCH /api/local/host/listings/[id]/visibility failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS })
  }
}
