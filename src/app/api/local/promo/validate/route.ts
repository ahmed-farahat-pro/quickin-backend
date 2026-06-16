import { NextResponse } from 'next/server'
import { quotePromo } from '@/lib/local/promote'

// POST /api/local/promo/validate { code, subtotal } → { valid, code, kind, value, discount, message }
// Preview only — no redemption. Public (the actual redeem happens at pay time).
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
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}))
    const quote = await quotePromo(b.code, Number(b.subtotal))
    return NextResponse.json(quote, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to validate code', detail: String(err) }, { status: 500, headers: CORS })
  }
}
