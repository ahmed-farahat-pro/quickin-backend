import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getListingGateState, getVerificationNote } from '@/lib/local/db'
import { canPublishListing } from '@/lib/local/host-verification-core'

// GET /api/local/host/listing-gate (Bearer) → { allowed, code, message, reason }
//
// May this host add a listing, and if not, why? The create route enforces the
// same rule and returns the same `code` on 403 — this exists so the apps can say
// so BEFORE the host fills in a whole listing, the way the website does.
//
// `reason` is the reviewer's note, and is returned ONLY when the documents were
// rejected: that is the one refusal the host can act on, and the note is written
// for them.
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
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.id === 'admin') {
      return NextResponse.json(
        { ...canPublishListing({ isHost: true, verificationStatus: 'verified', isStaff: true }), reason: null },
        { headers: CORS }
      )
    }
    const gate = canPublishListing(await getListingGateState(user.id))
    // Only on a rejection: that is the one refusal the host can act on, and the
    // note was written for them.
    const reason = gate.code === 'verification_rejected' ? await getVerificationNote(user.id) : null
    return NextResponse.json({ ...gate, reason }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load', detail: String(err) }, { status: 500, headers: CORS })
  }
}
