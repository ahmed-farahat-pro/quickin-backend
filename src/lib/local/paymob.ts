import crypto from 'node:crypto'

// Paymob (Accept) — Egypt card gateway. Real-world service payment → the App-Store/Play-compliant
// path (NOT IAP/Play Billing). Uses Paymob's CURRENT "Intention API + Unified Checkout":
//   1) backend POST /v1/intention/  (Authorization: Token <SECRET_KEY>) → returns client_secret
//   2) client opens  {BASE}/unifiedcheckout/?publicKey=<PUBLIC_KEY>&clientSecret=<client_secret>
//   3) Paymob POSTs the final transaction to notification_url (HMAC-signed) → we mark the booking paid
//   4) Paymob redirects the browser/WebView to redirection_url when done
// Configure on the BACKEND Vercel project:
//   PAYMOB_SECRET_KEY      secret key  (Settings → API keys → secret key, e.g. "egy_sk_...")
//   PAYMOB_PUBLIC_KEY      public key  (Settings → API keys → public key, e.g. "egy_pk_...")
//   PAYMOB_INTEGRATION_ID  online-card integration id (Payment Integrations)
//   PAYMOB_HMAC_SECRET     HMAC secret (verifies the webhook)
//   PAYMOB_BASE            optional, default https://accept.paymob.com  (KSA: ksa.paymob.com, UAE: uae.paymob.com)

const BASE = (process.env.PAYMOB_BASE || 'https://accept.paymob.com').replace(/\/+$/, '')
const SECRET_KEY = process.env.PAYMOB_SECRET_KEY || ''
const PUBLIC_KEY = process.env.PAYMOB_PUBLIC_KEY || ''
const INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID || ''
const HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET || ''

export const paymobConfigured = Boolean(SECRET_KEY && PUBLIC_KEY && INTEGRATION_ID)

export function paymobDiagnostics() {
  return {
    configured: paymobConfigured,
    base: BASE,
    secretKeySet: !!SECRET_KEY,
    publicKeySet: !!PUBLIC_KEY,
    integrationIdSet: !!INTEGRATION_ID,
    hmacSecretSet: !!HMAC_SECRET,
    missing: ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_INTEGRATION_ID', 'PAYMOB_HMAC_SECRET'].filter((k) => !process.env[k]),
  }
}

export interface PaymobBilling {
  first_name: string; last_name: string; email: string; phone_number: string
}

export function checkoutUrl(clientSecret: string): string {
  return `${BASE}/unifiedcheckout/?publicKey=${encodeURIComponent(PUBLIC_KEY)}&clientSecret=${encodeURIComponent(clientSecret)}`
}

/** Create a payment Intention and return the hosted Unified-Checkout URL for the client to open. */
export async function createIntention(opts: {
  amountCents: number
  currency: string
  specialReference: string
  billing: PaymobBilling
  notificationUrl: string
  redirectionUrl: string
  integrationId?: string | number
}): Promise<{ clientSecret: string; intentionId: string; checkoutUrl: string }> {
  if (!paymobConfigured) throw new Error('Paymob not configured')
  const NA = 'NA'
  const body = {
    amount: opts.amountCents,
    currency: opts.currency,
    payment_methods: [Number(opts.integrationId || INTEGRATION_ID)],
    special_reference: opts.specialReference,
    notification_url: opts.notificationUrl,
    redirection_url: opts.redirectionUrl,
    billing_data: {
      first_name: opts.billing.first_name || NA,
      last_name: opts.billing.last_name || NA,
      email: opts.billing.email || NA,
      phone_number: opts.billing.phone_number || NA,
      apartment: NA, floor: NA, street: NA, building: NA, city: NA, state: NA, country: NA, postal_code: NA,
    },
  }
  const r = await fetch(`${BASE}/v1/intention/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Token ${SECRET_KEY}` },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`paymob intention failed (${r.status}): ${await r.text().catch(() => '')}`)
  const d = await r.json()
  const clientSecret = d.client_secret as string
  return { clientSecret, intentionId: String(d.id ?? ''), checkoutUrl: checkoutUrl(clientSecret) }
}

/** The exact string Paymob signs: the canonical 20-field order, concatenated. */
function transactionHmacBasis(obj: Record<string, unknown>): string {
  const sd = (obj.source_data || {}) as Record<string, unknown>
  const order = (obj.order || {}) as Record<string, unknown>
  return [
    obj.amount_cents, obj.created_at, obj.currency, obj.error_occured, obj.has_parent_transaction,
    obj.id, obj.integration_id, obj.is_3d_secure, obj.is_auth, obj.is_capture, obj.is_refunded,
    obj.is_standalone_payment, obj.is_voided, order.id, obj.owner, obj.pending,
    sd.pan, sd.sub_type, sd.type, obj.success,
  ].map((v) => (v === undefined || v === null ? '' : String(v))).join('')
}

/** Verify a Paymob TRANSACTION webhook by recomputing its HMAC (SHA-512) over the canonical field order. */
export function verifyTransactionHmac(obj: Record<string, unknown>, received: string): boolean {
  if (!HMAC_SECRET || !received) return false
  const expected = crypto.createHmac('sha512', HMAC_SECRET).update(transactionHmacBasis(obj)).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(received)))
  } catch {
    return false
  }
}

/** Non-secret diagnostics for an HMAC mismatch. Tells wrong-secret (basis fields present, hashes
 *  differ) from wrong-payload (basis empty/short) from missing-signature. Prints prefixes only —
 *  an HMAC digest is not the secret, but we still truncate. TEMP: pair with the webhook diag log. */
export function debugTransactionHmac(obj: Record<string, unknown>, received: string) {
  const basis = transactionHmacBasis(obj)
  const expected = HMAC_SECRET ? crypto.createHmac('sha512', HMAC_SECRET).update(basis).digest('hex') : ''
  return {
    hmacSecretSet: !!HMAC_SECRET,
    receivedLen: String(received || '').length,
    receivedPrefix: String(received || '').slice(0, 10),
    expectedPrefix: expected.slice(0, 10),
    match: !!expected && expected === String(received || ''),
    basisLen: basis.length,
    // Which fields were actually present — an empty/short basis means we're hashing the wrong object.
    fieldsPresent: [obj.amount_cents, obj.id, (obj.order as Record<string, unknown>)?.id, obj.success]
      .filter((v) => v !== undefined && v !== null).length,
  }
}
