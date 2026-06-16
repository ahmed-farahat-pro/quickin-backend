import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { submitVerification, getVerificationStatus } from '@/lib/local/trust'

// Identity verification for the signed-in user.
//   GET  /api/local/verification        → { status, verified_at }
//   POST /api/local/verification { doc } → submit an ID image → status 'pending'
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
    return NextResponse.json(await getVerificationStatus(user.id), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load verification', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const doc = b.doc ?? b.verification_doc ?? b.image
    const state = await submitVerification(user.id, doc)
    return NextResponse.json(state, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to submit verification'
    return NextResponse.json({ error: msg }, { status: 400, headers: CORS })
  }
}
