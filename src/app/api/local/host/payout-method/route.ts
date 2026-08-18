import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getListingGateState, getPayoutMethod, savePayoutMethod, deletePayoutMethod } from '@/lib/local/db'
import { isPayoutMethodError, isPayoutReady, validatePayout } from '@/lib/local/payout-method-core'

// The signed-in host's payout method — where QuickIn sends their earnings.
//   GET    /api/local/host/payout-method  → { payout_method, payout_ready, is_host }
//   PUT    /api/local/host/payout-method  {method, account_name, …} → saves/replaces it
//   DELETE /api/local/host/payout-method  → removes it
//
// Host-only: this is how a host gets paid, so a guest has nothing to set here.
// A refusal carries `code: 'not_host'` so the apps can offer "Apply to become a
// host" instead of an error, matching /api/local/host/listing-gate.
//
// PUT never sees a full card number leave the validator: validatePayout returns
// only the brand and last four, and that return value is the only thing written.
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

const NOT_HOST = {
  error: 'Only hosts have a payout method. Apply to become a host first.',
  code: 'not_host',
}

/** Either a refusal to return as-is, or the id of an approved host. */
type HostGate =
  | { error: NextResponse; userId?: undefined }
  | { error?: undefined; userId: string }

/** Resolve the caller, refusing anyone who is not an approved host. */
async function requireHost(req: Request): Promise<HostGate> {
  const user = await getUserFromRequest(req)
  if (!user) {
    return { error: NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS }) }
  }
  // The hardcoded admin token is not a real user row and has no earnings.
  if (user.id === 'admin') {
    return { error: NextResponse.json(NOT_HOST, { status: 403, headers: CORS }) }
  }
  const { isHost } = await getListingGateState(user.id)
  if (!isHost) {
    return { error: NextResponse.json(NOT_HOST, { status: 403, headers: CORS }) }
  }
  return { userId: user.id }
}

export async function GET(req: Request) {
  try {
    const gate = await requireHost(req)
    if (gate.error) return gate.error
    const payout_method = await getPayoutMethod(gate.userId)
    return NextResponse.json(
      { payout_method, payout_ready: isPayoutReady(payout_method), is_host: true },
      { headers: CORS }
    )
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load payout method', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function PUT(req: Request) {
  try {
    const gate = await requireHost(req)
    if (gate.error) return gate.error
    const body = await req.json().catch(() => ({}))
    const record = validatePayout(body)
    const payout_method = await savePayoutMethod(gate.userId, record)
    return NextResponse.json(
      { payout_method, payout_ready: isPayoutReady(payout_method), is_host: true },
      { headers: CORS }
    )
  } catch (err) {
    // Bad input is the host's to fix, so answer 400 with the validator's wording
    // rather than a generic failure they cannot act on.
    if (isPayoutMethodError(err)) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400, headers: CORS })
    }
    return NextResponse.json({ error: 'Failed to save payout method', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function DELETE(req: Request) {
  try {
    const gate = await requireHost(req)
    if (gate.error) return gate.error
    const removed = await deletePayoutMethod(gate.userId)
    return NextResponse.json({ removed, payout_method: null, payout_ready: false }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to remove payout method', detail: String(err) }, { status: 500, headers: CORS })
  }
}
