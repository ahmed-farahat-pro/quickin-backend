import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { submitVerificationImages, getVerificationStatusFromTable } from '@/lib/local/db'

// Identity verification for the signed-in user. Writes to the shared
// id_verifications TABLE so the web /ops admin can see mobile submissions.
//   GET  /api/local/verification                 → { status, verified_at }
//   POST /api/local/verification { front, back }  → upload FRONT + BACK ID photos → { status: 'pending' }
// Back-compat: { doc } or { image } is treated as the FRONT only.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

// Accept a raw base64 JPEG OR a full data URL; normalize to a data:image/jpeg URL.
function normalizeImage(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (/^data:image\//i.test(s) || /^https?:\/\//i.test(s)) return s
  // Raw base64 — wrap as a JPEG data URL (strip any stray whitespace/newlines).
  return `data:image/jpeg;base64,${s.replace(/\s+/g, '')}`
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
    return NextResponse.json(await getVerificationStatusFromTable(user.id), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load verification', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))

    // FRONT: prefer { front }; legacy { doc } / { image } / { verification_doc } => FRONT only.
    const front = normalizeImage(b.front ?? b.doc ?? b.image ?? b.verification_doc)
    const back = normalizeImage(b.back)
    if (!front) throw new Error('Please attach a photo of the front of your ID')

    const idNumber = typeof b.id_number === 'string' && b.id_number.trim() ? b.id_number.trim() : null
    const fullName = typeof b.full_name === 'string' && b.full_name.trim() ? b.full_name.trim() : null

    const state = await submitVerificationImages({ userId: user.id, front, back, idNumber, fullName })
    return NextResponse.json(state, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to submit verification'
    return NextResponse.json({ error: msg }, { status: 400, headers: CORS })
  }
}
