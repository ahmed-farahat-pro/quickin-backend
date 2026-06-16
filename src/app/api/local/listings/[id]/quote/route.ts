import { NextResponse } from 'next/server'
import { getStayQuote } from '@/lib/local/db'

// GET/POST /api/local/listings/:id/quote?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
//   → { nights, subtotal, discountPercent, total, nightlyAvg, currency, hasSeasonalPricing }
// Authoritative price for a date range — honors weekend + monthly pricing + the
// length-of-stay discount (same maths the booking uses). Public.
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

async function quote(id: string, checkIn: string, checkOut: string) {
  const q = await getStayQuote(id, checkIn, checkOut)
  if (!q) return NextResponse.json({ error: 'Invalid listing or dates' }, { status: 400, headers: CORS })
  return NextResponse.json(q, { headers: CORS })
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sp = new URL(req.url).searchParams
  return quote(id, sp.get('checkIn') ?? sp.get('check_in') ?? '', sp.get('checkOut') ?? sp.get('check_out') ?? '')
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const b = await req.json().catch(() => ({}))
  return quote(id, b.checkIn ?? b.check_in ?? '', b.checkOut ?? b.check_out ?? '')
}
