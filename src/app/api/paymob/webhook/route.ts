import { NextResponse } from 'next/server'
import { verifyTransactionHmac, debugTransactionHmac, findHmacScheme } from '@/lib/local/paymob'
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
    // The transaction object lives under different keys across Paymob flows:
    //   Unified Checkout / Intention → body.transaction ; legacy iframe → body.obj ; raw → body.
    const tx = (body?.transaction ?? body?.obj ?? body) as Record<string, unknown> | null
    // The transaction signature may arrive in the query (?hmac=) or, for Unified Checkout, in the
    // body as `hmac` or `partner_digest`. Try them all — verifyTransactionHmac accepts the matching one.
    const qHmac = url.searchParams.get('hmac') || ''
    const bHmac = String(body?.hmac || '')
    const pDigest = String(body?.partner_digest || '')
    const hmacCandidates = [qHmac, bHmac, pDigest].filter(Boolean)

    // TEMP DIAGNOSTIC (structure only — no PII values). Remove once settlement is confirmed.
    {
      const ord = (tx?.order || {}) as Record<string, unknown>
      console.log(
        '[paymob][diag] txKeys=[%s] qHmacLen=%d bodyHmacLen=%d partnerDigestLen=%d success=%s pending=%s txn=%s order.id=%s merchant_order_id=%s amount_cents=%s',
        tx ? Object.keys(tx).join(',') : 'null',
        qHmac.length, bHmac.length, pDigest.length,
        String(tx?.success), String(tx?.pending), String(tx?.id), String(ord.id), String(ord.merchant_order_id), String(tx?.amount_cents),
      )
    }

    if (!tx || typeof tx !== 'object') {
      console.log('[paymob] ignored: no transaction object in payload')
      return NextResponse.json({ ok: true, ignored: true })
    }
    if (!hmacCandidates.some((h) => verifyTransactionHmac(tx, h))) {
      const scheme = findHmacScheme(body, [
        { name: 'query', value: qHmac }, { name: 'body.hmac', value: bHmac }, { name: 'partner_digest', value: pDigest },
      ])
      console.error('[paymob] HMAC mismatch — scheme search:', JSON.stringify(scheme), JSON.stringify(debugTransactionHmac(tx, bHmac || qHmac || pDigest)))
      // TEMP: full raw payload (one-time capture for offline replay via /api/paymob/hmacdebug). Remove after.
      console.error('[paymob][rawbody]', JSON.stringify(body))
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
    }
    const txnId = String(tx.id ?? '')
    const bookingId = recoverBookingId(body, tx)
    if (!bookingId) {
      console.log(`[paymob] txn ${txnId} — could not recover booking id; ignored`)
      return NextResponse.json({ ok: true, ignored: true })
    }

    const success = truthy(tx.success)
    const pending = truthy(tx.pending)
    const refunded = truthy(tx.is_refunded)
    const voided = truthy(tx.is_voided)

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
