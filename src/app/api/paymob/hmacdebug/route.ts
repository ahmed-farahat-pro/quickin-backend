// TEMPORARY Paymob HMAC scheme finder. Key-gated. REMOVE once settlement works.
// Replay a REAL captured callback payload (from Paymob's dashboard, or the [paymob][rawbody] log line)
// to discover exactly which HMAC scheme Paymob used — no new test payments needed.
//
//   curl -s -X POST 'https://quickin-backend.vercel.app/api/paymob/hmacdebug?key=qk-pmtest-4f7a' \
//     -H 'content-type: application/json' \
//     -d '<paste the raw callback JSON here>'
//
// Returns { matches: [...] } — e.g. "transaction/classic:std/sha512/hex == body.hmac" — which tells
// us the exact object + field order + boolean repr + algorithm + encoding + signature field to use.
import { NextResponse } from 'next/server'
import { findHmacScheme } from '@/lib/local/paymob'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const KEY = 'qk-pmtest-4f7a'

export async function POST(req: Request) {
  const url = new URL(req.url)
  if (url.searchParams.get('key') !== KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'POST the raw Paymob callback JSON as the body' }, { status: 400 })
  }
  const b = body as Record<string, unknown>
  const candidates = [
    { name: 'query.hmac', value: url.searchParams.get('hmac') || '' },
    { name: 'body.hmac', value: String(b.hmac || '') },
    { name: 'body.partner_digest', value: String(b.partner_digest || '') },
  ]
  const matches = findHmacScheme(body, candidates)
  return NextResponse.json({
    matches,
    bodyKeys: Object.keys(b),
    signatureLengths: {
      query: (url.searchParams.get('hmac') || '').length,
      bodyHmac: String(b.hmac || '').length,
      partnerDigest: String(b.partner_digest || '').length,
    },
  })
}
