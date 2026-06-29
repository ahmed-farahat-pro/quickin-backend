import { NextResponse } from 'next/server'
import { verifyTransactionHmac } from '@/lib/local/paymob'
import { getBookingById, markBookingPaid, setBookingPaymentOutcome } from '@/lib/local/db'

const truthy = (v: unknown) => v === true || v === 'true'

// Paymob server-to-server "processed" callback (the source of truth for payment).
// Configure this URL in the Paymob dashboard as the Transaction Processed Callback:
//   https://quickin-backend.vercel.app/api/paymob/webhook
// Paymob appends ?hmac=... and POSTs { type:'TRANSACTION', obj:{...} }. We verify the HMAC,
// then mark the matching booking paid. We always return 200 so Paymob doesn't retry forever.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const hmac = new URL(req.url).searchParams.get('hmac') || ''
    const body = await req.json().catch(() => null)
    if (!body || body.type !== 'TRANSACTION' || !body.obj) {
      return NextResponse.json({ ok: true, ignored: true })
    }
    const obj = body.obj as Record<string, unknown>
    if (!verifyTransactionHmac(obj, hmac)) {
      console.error('[paymob] webhook rejected: HMAC mismatch')
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
    }
    const txnId = String(obj.id ?? '')
    const order = (obj.order || {}) as Record<string, unknown>
    const merchantOrderId = String(order.merchant_order_id || '')
    const bookingId = merchantOrderId.split('__')[0]
    if (!bookingId) {
      console.log(`[paymob] txn ${txnId} has no booking ref (order=${merchantOrderId}) — ignored`)
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
