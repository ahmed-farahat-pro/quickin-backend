import { NextResponse } from 'next/server'
import { verifyTransactionHmac } from '@/lib/local/paymob'
import { getBookingById, markBookingPaid } from '@/lib/local/db'

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
    const success = obj.success === true || obj.success === 'true'
    const order = (obj.order || {}) as Record<string, unknown>
    const merchantOrderId = String(order.merchant_order_id || '')
    const bookingId = merchantOrderId.split('__')[0]
    if (success && bookingId) {
      const bk = await getBookingById(bookingId)
      if (bk && !bk.paid_at) {
        await markBookingPaid(bookingId, bk.user_id, 'card')
        console.log(`[paymob] booking ${bookingId} marked paid (txn ${String(obj.id)})`)
      }
    } else {
      console.log(`[paymob] txn ${String(obj.id)} success=${success} order=${merchantOrderId} — not marking paid`)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[paymob] webhook error:', err)
    return NextResponse.json({ ok: true }) // swallow so Paymob stops retrying; logged for us
  }
}
