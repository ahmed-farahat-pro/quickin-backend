import crypto from 'node:crypto'

// Paymob (Accept) integration — Egypt's card gateway. Real-world service payment, so this is
// the App-Store/Play-compliant path (NOT IAP/Play Billing). Flow: auth → order → payment_key →
// hosted iFrame; Paymob calls our webhook (HMAC-signed) with the final transaction result.
// Configure on the backend project:
//   PAYMOB_API_KEY        secret API key (Paymob dashboard → Settings → Account Info)
//   PAYMOB_INTEGRATION_ID online-card integration id (Developers → Payment Integrations)
//   PAYMOB_IFRAME_ID      iframe id (Developers → iframes)
//   PAYMOB_HMAC_SECRET    HMAC secret (used to verify webhook authenticity)
//   PAYMOB_BASE           optional, defaults to https://accept.paymob.com

const BASE = (process.env.PAYMOB_BASE || 'https://accept.paymob.com').replace(/\/+$/, '')
const API_KEY = process.env.PAYMOB_API_KEY || ''
const INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID || ''
const IFRAME_ID = process.env.PAYMOB_IFRAME_ID || ''
const HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET || ''

export const paymobConfigured = Boolean(API_KEY && INTEGRATION_ID && IFRAME_ID)

export function paymobDiagnostics() {
  return {
    configured: paymobConfigured,
    base: BASE,
    apiKeySet: !!API_KEY,
    integrationIdSet: !!INTEGRATION_ID,
    iframeIdSet: !!IFRAME_ID,
    hmacSecretSet: !!HMAC_SECRET,
    missing: ['PAYMOB_API_KEY', 'PAYMOB_INTEGRATION_ID', 'PAYMOB_IFRAME_ID', 'PAYMOB_HMAC_SECRET']
      .filter((k) => !process.env[k]),
  }
}

async function authenticate(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: API_KEY }),
  })
  if (!r.ok) throw new Error(`paymob auth failed (${r.status}): ${await r.text().catch(() => '')}`)
  return (await r.json()).token as string
}

async function registerOrder(token: string, amountCents: number, currency: string, merchantOrderId: string): Promise<number> {
  const r = await fetch(`${BASE}/api/ecommerce/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: token, delivery_needed: false, amount_cents: amountCents, currency, merchant_order_id: merchantOrderId, items: [] }),
  })
  if (!r.ok) throw new Error(`paymob order failed (${r.status}): ${await r.text().catch(() => '')}`)
  return (await r.json()).id as number
}

export interface PaymobBilling {
  first_name: string; last_name: string; email: string; phone_number: string
}

async function paymentKey(token: string, amountCents: number, currency: string, orderId: number, billing: PaymobBilling): Promise<string> {
  const NA = 'NA'
  const billing_data = {
    first_name: billing.first_name || NA, last_name: billing.last_name || NA,
    email: billing.email || NA, phone_number: billing.phone_number || NA,
    apartment: NA, floor: NA, street: NA, building: NA, shipping_method: NA,
    postal_code: NA, city: NA, country: NA, state: NA,
  }
  const r = await fetch(`${BASE}/api/acceptance/payment_keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: token, amount_cents: amountCents, expiration: 3600, order_id: orderId, billing_data, currency, integration_id: Number(INTEGRATION_ID), lock_order_when_paid: true }),
  })
  if (!r.ok) throw new Error(`paymob payment_key failed (${r.status}): ${await r.text().catch(() => '')}`)
  return (await r.json()).token as string
}

export function iframeUrl(paymentToken: string): string {
  return `${BASE}/api/acceptance/iframes/${IFRAME_ID}?payment_token=${paymentToken}`
}

/** Run the full auth→order→payment_key flow and return the hosted-iframe URL for the client. */
export async function createPayment(opts: { amountCents: number; currency: string; merchantOrderId: string; billing: PaymobBilling }): Promise<{ paymentToken: string; orderId: number; iframeUrl: string }> {
  if (!paymobConfigured) throw new Error('Paymob not configured')
  const token = await authenticate()
  const orderId = await registerOrder(token, opts.amountCents, opts.currency, opts.merchantOrderId)
  const paymentToken = await paymentKey(token, opts.amountCents, opts.currency, orderId, opts.billing)
  return { paymentToken, orderId, iframeUrl: iframeUrl(paymentToken) }
}

/** Verify a Paymob TRANSACTION webhook by recomputing its HMAC (SHA-512) over the
 *  canonical field order. Returns true only if the signature matches. */
export function verifyTransactionHmac(obj: Record<string, unknown>, received: string): boolean {
  if (!HMAC_SECRET || !received) return false
  const sd = (obj.source_data || {}) as Record<string, unknown>
  const order = (obj.order || {}) as Record<string, unknown>
  const parts = [
    obj.amount_cents, obj.created_at, obj.currency, obj.error_occured, obj.has_parent_transaction,
    obj.id, obj.integration_id, obj.is_3d_secure, obj.is_auth, obj.is_capture, obj.is_refunded,
    obj.is_standalone_payment, obj.is_voided, order.id, obj.owner, obj.pending,
    sd.pan, sd.sub_type, sd.type, obj.success,
  ].map((v) => (v === undefined || v === null ? '' : String(v))).join('')
  const expected = crypto.createHmac('sha512', HMAC_SECRET).update(parts).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(received)))
  } catch {
    return false
  }
}
