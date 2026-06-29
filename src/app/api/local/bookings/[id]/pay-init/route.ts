import { NextResponse } from 'next/server'
import { getBookingById, markBookingPaid } from '@/lib/local/db'
import { getUserFromRequest, getUserById } from '@/lib/local/auth'
import { createIntention, paymobConfigured } from '@/lib/local/paymob'

// POST /api/local/bookings/:id/pay-init — start payment for a booking.
// DUAL MODE:
//  - Paymob fully configured (valid keys + integration) → returns a real Paymob Unified-Checkout
//    URL; the booking is marked paid only by the webhook.
//  - Paymob not yet configured (no keys, or integration not live yet) → confirms the reservation
//    WITHOUT an online charge ("pay arranged with host") and returns the return page as the
//    checkout_url, so every client flows to a clean "confirmed" state (review-ready, no fake card).
// The client behaviour is identical either way: open checkout_url, watch for return_url_prefix.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}
const SERVICE_FEE_RATE = 0.1

// Where the web client may ask Paymob to return the browser after checkout. We only honour
// a caller-supplied redirect_url if its origin is allowlisted (WEB_APP_URL, comma-separated),
// so this can't become an open redirect. Returns a safe absolute URL with ?booking=<id>, or null.
function safeRedirect(raw: unknown, bookingId: string): string | null {
  if (typeof raw !== 'string' || !raw) return null
  const allow = (process.env.WEB_APP_URL || '')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
  if (!allow.length) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null
    if (!allow.some((a) => { try { return new URL(a).origin === u.origin } catch { return false } })) return null
    u.searchParams.set('booking', bookingId)
    return u.toString()
  } catch {
    return null
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const me = await getUserFromRequest(req)
    if (!me) return NextResponse.json({ error: 'Please sign in to pay' }, { status: 401, headers: CORS })

    const bk = await getBookingById(id)
    if (!bk) return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    if (bk.user_id !== me.id) return NextResponse.json({ error: 'Not allowed' }, { status: 403, headers: CORS })
    if (bk.paid_at) return NextResponse.json({ already_paid: true, booking: bk }, { headers: CORS })

    const origin = new URL(req.url).origin
    const returnPrefix = `${origin}/api/paymob/return`
    const body = await req.json().catch(() => ({})) as { redirect_url?: unknown }
    // Web clients pass their own /reservations URL; mobile omits it and lands on our return page.
    const redirectionUrl = safeRedirect(body.redirect_url, id) || `${returnPrefix}?booking=${id}`
    const subtotal = Math.round(bk.total_price)
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE)
    const amountCents = (subtotal + serviceFee) * 100

    // Try real Paymob; if it isn't ready, fall back to a no-charge confirmation.
    if (paymobConfigured) {
      try {
        const u = await getUserById(me.id)
        const parts = String(u?.full_name || 'Guest User').trim().split(/\s+/)
        const billing = { first_name: parts[0] || 'Guest', last_name: parts.slice(1).join(' ') || 'User', email: u?.email || me.email, phone_number: 'NA' }
        const intent = await createIntention({
          amountCents, currency: 'EGP', specialReference: `${id}__${Date.now()}`, billing,
          notificationUrl: `${origin}/api/paymob/webhook`,
          redirectionUrl,
        })
        return NextResponse.json({
          ok: true, mode: 'checkout',
          checkout_url: intent.checkoutUrl, return_url_prefix: returnPrefix,
          amount_cents: amountCents, currency: 'EGP', reference: bk.reservation_code,
        }, { headers: CORS })
      } catch (e) {
        console.error('[pay-init] paymob intention failed, falling back to confirm:', e)
      }
    }

    // Fallback: confirm the reservation with no online charge (payment arranged with the host).
    await markBookingPaid(id, bk.user_id, 'offline')
    return NextResponse.json({
      ok: true, mode: 'confirmed', no_online_charge: true,
      checkout_url: `${returnPrefix}?booking=${id}&confirmed=1`, return_url_prefix: returnPrefix,
      amount_cents: amountCents, currency: 'EGP', reference: bk.reservation_code,
    }, { headers: CORS })
  } catch (err) {
    console.error('pay-init failed:', err)
    return NextResponse.json({ error: 'Could not start payment', detail: String(err) }, { status: 500, headers: CORS })
  }
}
