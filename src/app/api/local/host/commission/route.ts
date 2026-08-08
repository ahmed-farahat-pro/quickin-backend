import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getCommissionConfig } from '@/lib/local/db'
import { DEFAULT_COMMISSION_RATE, percentFromRate } from '@/lib/local/commission-core'

// GET /api/local/host/commission (Bearer) → { rate, percent }
//
// The platform commission, so the add/edit-listing screens can show a host what
// guests will actually pay for the price they are typing. The host has no
// listing yet on the add screen, so this cannot come from the listing payload
// (which does carry `commission_rate` for the edit screen).
//
// AUTH-GATED ON PURPOSE, even though the value is not secret in itself: guests
// see one inclusive price with no commission line, and anyone holding the rate
// can divide it back out to recover the host's raw price.
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
    const { rate, percent } = await getCommissionConfig()
    return NextResponse.json({ rate, percent }, { headers: CORS })
  } catch (err) {
    // Never fail the listing form over this — the hint is advisory, and the
    // server prices the listing regardless of what the client displayed.
    return NextResponse.json(
      { rate: DEFAULT_COMMISSION_RATE, percent: percentFromRate(DEFAULT_COMMISSION_RATE), degraded: String(err) },
      { headers: CORS }
    )
  }
}
