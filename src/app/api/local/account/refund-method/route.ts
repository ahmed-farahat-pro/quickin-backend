import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getPayoutMethod, savePayoutMethod, deletePayoutMethod } from '@/lib/local/db'
import { isPayoutMethodError, isPayoutReady, validatePayout } from '@/lib/local/payout-method-core'

// The signed-in user's refund destination — where Quick In sends a guest's money
// back when a paid stay is cancelled. Optional; a guest gives it on the signup's
// refund step or later on their profile.
//   GET    /api/local/account/refund-method  → { refund_method, refund_ready }
//   PUT    /api/local/account/refund-method  {method, account_name, …} → saves/replaces it
//   DELETE /api/local/account/refund-method  → removes it
//
// It is the SAME one-row-per-user record as a host's payout method
// (/api/local/host/payout-method) — one place we send this person money — so it
// is open to any signed-in user, and a guest who becomes a host keeps it as
// their payout destination. Validation is payout-method-core's.
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
      'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

async function requireUser(req: Request): Promise<{ error: NextResponse; userId?: undefined } | { error?: undefined; userId: string }> {
  const user = await getUserFromRequest(req)
  // The hardcoded admin token is not a real user row and is owed nothing.
  if (!user || user.id === 'admin') {
    return { error: NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS }) }
  }
  return { userId: user.id }
}

export async function GET(req: Request) {
  try {
    const gate = await requireUser(req)
    if (gate.error) return gate.error
    const refund_method = await getPayoutMethod(gate.userId)
    return NextResponse.json({ refund_method, refund_ready: isPayoutReady(refund_method) }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load refund details', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function PUT(req: Request) {
  try {
    const gate = await requireUser(req)
    if (gate.error) return gate.error
    const body = await req.json().catch(() => ({}))
    const refund_method = await savePayoutMethod(gate.userId, validatePayout(body))
    return NextResponse.json({ refund_method, refund_ready: isPayoutReady(refund_method) }, { headers: CORS })
  } catch (err) {
    if (isPayoutMethodError(err)) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400, headers: CORS })
    }
    return NextResponse.json({ error: 'Failed to save refund details', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function DELETE(req: Request) {
  try {
    const gate = await requireUser(req)
    if (gate.error) return gate.error
    const removed = await deletePayoutMethod(gate.userId)
    return NextResponse.json({ removed, refund_method: null, refund_ready: false }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to remove refund details', detail: String(err) }, { status: 500, headers: CORS })
  }
}
