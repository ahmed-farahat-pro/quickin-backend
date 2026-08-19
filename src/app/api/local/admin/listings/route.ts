import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { listPendingListings, setListingApproval } from '@/lib/local/db'

// Admin listing-moderation queue.
//   GET  /api/local/admin/listings                       → pending listings (with ownership_doc + host email)
//   POST /api/local/admin/listings { listing_id, action, note? } → action: "approve" | "reject"
//        `note` is the optional reason a rejection shows the host — it is stored on
//        the listing (listings.review_note), not just announced in a notification.
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
    const gate = await requireStaff(req, 'listings')
    if ('error' in gate) return gate.error
    return NextResponse.json(await listPendingListings(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load pending listings', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const gate = await requireStaff(req, 'listings')
    if ('error' in gate) return gate.error
    const b = await req.json().catch(() => ({}))
    const listingId = String(b.listing_id ?? b.listingId ?? '')
    const action = String(b.action ?? '')
    if (!/^(approve|reject)$/i.test(action)) {
      return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400, headers: CORS })
    }
    const approve = /^approve$/i.test(action)
    const updated = await setListingApproval(listingId, approve, b.note ?? b.review_note ?? null)
    if (!updated) return NextResponse.json({ error: 'Listing not found' }, { status: 404, headers: CORS })
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'listing_moderated',
      targetType: 'listing',
      targetId: listingId,
      // Whether a reason was given, not the reason itself — the audit log is read by
      // every staff member, and the note is already on the listing.
      detail: { action, noted: !!updated.review_note },
      ip: clientIpOf(req),
    })
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update listing', detail: String(err) }, { status: 500, headers: CORS })
  }
}
