import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getFlashCheckout, isFlashCheckoutError, startFlashCheckout } from '@/lib/local/flash-payments'

// Flash (useflash.app) — the automatic card/wallet way to pay a booking.
//   POST /api/local/bookings/:id/flash-checkout
//        → start or resume a checkout: {status, paid, payment_link, expires_at,
//          amount_cents, order_id}. Open `payment_link` in a browser; the guest
//          pays on Flash's page. Re-POSTing while a link is still good returns
//          the SAME link rather than a second order.
//   GET  /api/local/bookings/:id/flash-checkout
//        → the same shape, refreshed from Flash. Poll it after the guest comes
//          back from the checkout page; stop when `paid` is true.
// Guest (booking owner) only. 409 {code:'flash_unavailable'} when the method is
// off or unconfigured, 409 {code:'not_payable'} when the booking can't be paid
// (not yet accepted by the host, cancelled, or a transfer is under review).
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

function fail(err: unknown) {
  if (isFlashCheckoutError(err)) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: CORS })
  }
  console.error('[flash-checkout]', err)
  return NextResponse.json({ error: 'Card payment failed — please try again' }, { status: 500, headers: CORS })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    return NextResponse.json(await startFlashCheckout(id, user.id), { headers: CORS })
  } catch (err) {
    return fail(err)
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    return NextResponse.json(await getFlashCheckout(id, user.id), { headers: CORS })
  } catch (err) {
    return fail(err)
  }
}
