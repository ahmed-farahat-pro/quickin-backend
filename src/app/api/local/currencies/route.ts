import { NextResponse } from 'next/server'
import { getCurrencies } from '@/lib/local/money'

// GET /api/local/currencies → { base: "EGP", rates: { USD, EUR, ... } }
// Static display-only conversion rates (bookings are always charged in EGP).
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'public, max-age=3600',
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

export async function GET() {
  return NextResponse.json(await getCurrencies(), { headers: CORS })
}
