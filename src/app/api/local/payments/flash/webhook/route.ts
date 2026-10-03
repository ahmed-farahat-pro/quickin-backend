import { NextResponse } from 'next/server'
import { flashSettings, getFlashOrder } from '@/lib/local/flash'
import { parseWebhook, verifySignature } from '@/lib/local/flash-core'
import { applyFlashStatus } from '@/lib/local/flash-payments'

// POST /api/local/payments/flash/webhook — Flash's transaction notifications.
// This URL is what we give Flash as the callback.
//
// Trust model, in order:
//   1. The `signature` header must be HMAC-SHA256 of the flattened body with
//      FLASH_HMAC_SECRET (flash-core.verifySignature). Unsigned or wrong → 401.
//   2. Even a signed report is then re-read from Flash's order API, and THAT
//      status is what's applied — the webhook is a doorbell, not the record.
//      Only if the read fails do we fall back to the signed body.
//   3. Applying is idempotent and forward-only, so retries and a racing status
//      poll are harmless.
// Answers 200 for an order we don't know, so Flash stops retrying something we
// will never be able to place.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const s = flashSettings()
  if (!s) return NextResponse.json({ error: 'Flash is not configured' }, { status: 503 })

  const raw = await req.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!verifySignature(body, req.headers.get('signature'), s.hmacSecret)) {
    console.warn('[flash-webhook] bad signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const report = parseWebhook(body)
  if (!report?.aggregatorOrderId) return NextResponse.json({ ok: true, ignored: 'no order id' })

  try {
    const authoritative = await getFlashOrder(report.aggregatorOrderId).catch((e) => {
      console.error('[flash-webhook] order read failed, using signed body', e)
      return null
    })
    // The order read has no paidAmountCents; carry the webhook's across so the
    // amount check still sees it.
    const applied = await applyFlashStatus(
      report.aggregatorOrderId,
      authoritative ? { ...authoritative, paidAmountCents: report.paidAmountCents } : report,
      body,
    )
    return NextResponse.json({ ok: true, known: applied })
  } catch (err) {
    console.error('[flash-webhook]', err)
    // 500 → Flash retries, which is what we want for a transient DB failure.
    return NextResponse.json({ error: 'Failed to apply' }, { status: 500 })
  }
}
