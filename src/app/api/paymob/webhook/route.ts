import { NextResponse } from 'next/server'
import { verifyTransactionHmac } from '@/lib/local/paymob'
import { getBookingById, markBookingPaid, setBookingPaymentOutcome } from '@/lib/local/db'

const truthy = (v: unknown) => v === true || v === 'true'

const UUID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__\d+/

/** Recover our booking id from Paymob's payload. We set special_reference = `${bookingId}__${ts}`.
 *  In the legacy flow it returns as order.merchant_order_id; the Intention/Unified-Checkout flow
 *  may surface it elsewhere, so as a fallback we scan the whole payload for the `<uuid>__<ts>`
 *  marker — a shape change then can't silently break settlement. */
function recoverBookingId(body: unknown, obj: Record<string, unknown>): string {
  const order = (obj.order || {}) as Record<string, unknown>
  const direct = String(order.merchant_order_id || '')
  if (direct.includes('__')) return direct.split('__')[0]
  try {
    const m = JSON.stringify(body).match(UUID_RE)
    if (m) return m[1]
  } catch { /* ignore */ }
  return ''
}

// Paymob server-to-server "processed" callback (the source of truth for payment).
// Configure this URL in the Paymob dashboard as the Transaction Processed Callback:
//   https://quickin-backend.vercel.app/api/paymob/webhook
// Paymob appends ?hmac=... and POSTs the transaction. We verify the HMAC, then settle the
// matching booking. We always return 200 so Paymob doesn't retry forever.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const url = new URL(req.url)
    const body = await req.json().catch(() => null)
    // hmac is normally in the query; tolerate the body too.
    const hmac = url.searchParams.get('hmac') || String(body?.hmac || '')
    // Accept both shapes: { type:'TRANSACTION', obj:{...} } and a raw transaction object.
    const obj = (body?.obj ?? body) as Record<string, unknown> | null

    // TEMP DIAGNOSTIC (structure only — no PII values). Remove once settlement is confirmed.
    {
      const ord = (obj?.order || {}) as Record<string, unknown>
      console.log(
        '[paymob][diag] bodyType=%s hmac=%s objKeys=[%s] orderKeys=[%s] success=%s pending=%s refunded=%s voided=%s txn=%s merchant_order_id=%s amount_cents=%s',
        body?.type, hmac ? 'present' : 'MISSING',
        obj ? Object.keys(obj).join(',') : 'null',
        Object.keys(ord).join(','),
        String(obj?.success), String(obj?.pending), String(obj?.is_refunded), String(obj?.is_voided),
        String(obj?.id), String(ord.merchant_order_id), String(obj?.amount_cents),
      )
    }

    if (!obj || (body?.type && body.type !== 'TRANSACTION')) {
      console.log(`[paymob] ignored: bodyType=${body?.type} hasObj=${!!obj}`)
      return NextResponse.json({ ok: true, ignored: true })
    }
    if (!verifyTransactionHmac(obj, hmac)) {
      console.error('[paymob] webhook rejected: HMAC mismatch')
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
    }
    const txnId = String(obj.id ?? '')
    const bookingId = recoverBookingId(body, obj)
    if (!bookingId) {
      console.log(`[paymob] txn ${txnId} — could not recover booking id; ignored`)
      return NextResponse.json({ ok: true, ignored: true })
    }

    const success = truthy(obj.success)
    const pending = truthy(obj.pending)
    const refunded = truthy(obj.is_refunded)
    const voided = truthy(obj.is_voided)

    // Exhaustive outcome handling. paid is the ONLY state that sets paid_at; the rest just
    // record status for the UI. The webhook is the single source of truth for all of these.
    if (refunded || voided) {
      await setBookingPaymentOutcome(bookingId, refunded ? 'refunded' : 'voided')
      console.log(`[paymob] booking ${bookingId} ${refunded ? 'refunded' : 'voided'} (txn ${txnId})`)
    } else if (success && !pending) {
      const bk = await getBookingById(bookingId)
      if (!bk) {
        console.warn(`[paymob] paid txn ${txnId} but booking ${bookingId} not found`)
      } else if (bk.paid_at) {
        console.log(`[paymob] booking ${bookingId} already paid — txn ${txnId} ignored`)
      } else {
        await markBookingPaid(bookingId, bk.user_id, 'card', txnId)
        console.log(`[paymob] booking ${bookingId} marked paid (txn ${txnId})`)
      }
    } else if (pending) {
      await setBookingPaymentOutcome(bookingId, 'pending')
      console.log(`[paymob] booking ${bookingId} payment pending (txn ${txnId})`)
    } else {
      await setBookingPaymentOutcome(bookingId, 'failed')
      console.log(`[paymob] booking ${bookingId} payment failed (txn ${txnId})`)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[paymob] webhook error:', err)
    return NextResponse.json({ ok: true }) // swallow so Paymob stops retrying; logged for us
  }
}
