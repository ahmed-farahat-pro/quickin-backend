import { NextResponse } from 'next/server'
import { verifyPaymentViaApi } from '@/lib/local/paymob'
import { getBookingById, markBookingPaid, setBookingPaymentOutcome } from '@/lib/local/db'

const truthy = (v: unknown) => v === true || v === 'true'
const UUID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__\d+/

/** Recover our booking id from a `<uuid>__<ts>` special_reference found anywhere in the payload. */
function recoverBookingId(body: unknown): string {
  try {
    const m = JSON.stringify(body).match(UUID_RE)
    if (m) return m[1]
  } catch { /* ignore */ }
  return ''
}

// Paymob "processed" callback. We do NOT trust the callback's HMAC (the Unified-Checkout signature
// scheme is opaque); instead we re-confirm the payment against Paymob's API with our secret key —
// that's the source of truth and is spoof-proof. We always return 200 so Paymob stops retrying.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)
    // Transaction lives under body.transaction (Unified) / body.obj (legacy) / body (raw).
    const tx = (body?.transaction ?? body?.obj ?? body) as Record<string, unknown> | null
    if (!tx || typeof tx !== 'object') {
      console.log('[paymob] ignored: no transaction object in payload')
      return NextResponse.json({ ok: true, ignored: true })
    }
    const txnId = String(tx.id ?? '')
    const intentionId = String((body?.intention as Record<string, unknown>)?.id ?? '')

    // Authoritative status straight from Paymob (not the callback body).
    const v = await verifyPaymentViaApi({ transactionId: txnId, intentionId })
    console.log('[paymob][verify]', JSON.stringify({ source: v.source, ok: v.ok, paid: v.paid, amountCents: v.amountCents, ref: v.specialReference, detail: v.detail }))

    // Bind to a booking via the AUTHORITATIVE special_reference when present, else the payload's.
    const bookingId = (v.specialReference.match(UUID_RE)?.[1]) || recoverBookingId(body)
    if (!bookingId) {
      console.log(`[paymob] txn ${txnId} — could not resolve booking id; ignored`)
      return NextResponse.json({ ok: true, ignored: true })
    }

    if (!v.ok) {
      // Couldn't reach/parse Paymob's API — do NOT settle on an unverified callback.
      console.error(`[paymob] txn ${txnId} unverified (API retrieve failed): ${JSON.stringify(v.detail)}`)
      return NextResponse.json({ ok: true, unverified: true })
    }

    if (v.paid) {
      const bk = await getBookingById(bookingId)
      if (!bk) {
        console.warn(`[paymob] paid txn ${txnId} but booking ${bookingId} not found`)
      } else if (bk.paid_at) {
        console.log(`[paymob] booking ${bookingId} already paid — txn ${txnId}`)
      } else {
        // Sanity-check the charged amount vs what pay-init created (subtotal + 10% fee). Warn-only
        // for now — the authoritative special_reference already binds this payment to the booking.
        const subtotal = Math.round(bk.total_price)
        const expected = (subtotal + Math.round(subtotal * 0.1)) * 100
        if (v.amountCents != null && v.amountCents !== expected) {
          console.warn(`[paymob] amount note booking ${bookingId}: paid ${v.amountCents} vs expected ${expected} (settling anyway)`)
        }
        await markBookingPaid(bookingId, bk.user_id, 'card', txnId)
        console.log(`[paymob] booking ${bookingId} marked paid via API verify (txn ${txnId})`)
      }
    } else if (truthy(tx.is_refunded) || truthy(tx.is_voided)) {
      await setBookingPaymentOutcome(bookingId, truthy(tx.is_refunded) ? 'refunded' : 'voided')
      console.log(`[paymob] booking ${bookingId} ${truthy(tx.is_refunded) ? 'refunded' : 'voided'} (txn ${txnId})`)
    } else if (truthy(tx.pending)) {
      await setBookingPaymentOutcome(bookingId, 'pending')
      console.log(`[paymob] booking ${bookingId} pending (txn ${txnId})`)
    } else {
      await setBookingPaymentOutcome(bookingId, 'failed')
      console.log(`[paymob] booking ${bookingId} failed (txn ${txnId})`)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[paymob] webhook error:', err)
    return NextResponse.json({ ok: true }) // swallow so Paymob stops retrying; logged for us
  }
}
