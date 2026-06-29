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
// Legacy API key (dashboard → Account Info → API Key). Needed to retrieve a transaction's
// authoritative status: POST /api/auth/tokens {api_key} → Bearer token → GET the transaction.
const API_KEY = process.env.PAYMOB_API_KEY || ''

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

// The canonical 20 fields Paymob signs, in order, as [name, value] pairs.
function transactionHmacFields(obj: Record<string, unknown>): [string, unknown][] {
  const sd = (obj.source_data || {}) as Record<string, unknown>
  const order = (obj.order || {}) as Record<string, unknown>
  return [
    ['amount_cents', obj.amount_cents], ['created_at', obj.created_at], ['currency', obj.currency],
    ['error_occured', obj.error_occured], ['has_parent_transaction', obj.has_parent_transaction],
    ['id', obj.id], ['integration_id', obj.integration_id], ['is_3d_secure', obj.is_3d_secure],
    ['is_auth', obj.is_auth], ['is_capture', obj.is_capture], ['is_refunded', obj.is_refunded],
    ['is_standalone_payment', obj.is_standalone_payment], ['is_voided', obj.is_voided],
    ['order.id', order.id], ['owner', obj.owner], ['pending', obj.pending],
    ['source_data.pan', sd.pan], ['source_data.sub_type', sd.sub_type], ['source_data.type', sd.type],
    ['success', obj.success],
  ]
}

const reprStd = (v: unknown) => (v === undefined || v === null ? '' : v === true ? 'true' : v === false ? 'false' : String(v))
const reprPy = (v: unknown) => (v === undefined || v === null ? '' : v === true ? 'True' : v === false ? 'False' : String(v))

/** The exact string Paymob signs: the canonical 20-field order, concatenated. */
function transactionHmacBasis(obj: Record<string, unknown>): string {
  return transactionHmacFields(obj).map(([, v]) => reprStd(v)).join('')
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
    // TEMP: each signed field's resolved value (pan is already masked by Paymob). An empty value
    // where one is expected (e.g. order.id) means a field-mapping bug; all-present + mismatch = bad secret.
    fields: transactionHmacFields(obj).map(([k, v]) => `${k}=${v === undefined || v === null ? '∅' : String(v)}`),
  }
}

function toNum(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface PaymentVerification {
  ok: boolean            // a Paymob retrieve call succeeded (we got an authoritative answer)
  paid: boolean          // the payment genuinely succeeded
  amountCents: number | null
  specialReference: string
  source: string         // which endpoint answered: 'transaction' | 'intention' | 'none'
  detail: Record<string, unknown>
}

/** Source of truth WITHOUT relying on the callback HMAC: ask Paymob (with our secret key) for the
 *  authoritative status of this transaction/intention. A spoofed webhook can't pass this — the
 *  retrieve only returns OUR account's records, and the intention's special_reference (which only
 *  we, holding the secret key, could have set) binds the payment to a specific booking. */
/** Exchange the legacy API key for a short-lived auth token (Bearer) used by acceptance endpoints. */
async function legacyAuthToken(detail: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: API_KEY }),
    cache: 'no-store',
  })
  detail.authStatus = r.status
  if (!r.ok) return ''
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>
  return String(d.token || '')
}

export async function verifyPaymentViaApi(opts: { transactionId?: string; intentionId?: string }): Promise<PaymentVerification> {
  const detail: Record<string, unknown> = {}
  const none: PaymentVerification = { ok: false, paid: false, amountCents: null, specialReference: '', source: 'none', detail }
  if (!API_KEY) { detail.error = 'PAYMOB_API_KEY not set'; return none }
  if (!opts.transactionId) { detail.error = 'no transactionId'; return none }
  try {
    const token = await legacyAuthToken(detail)
    if (!token) { detail.error = 'auth token failed'; return none }
    const r = await fetch(`${BASE}/api/acceptance/transactions/${encodeURIComponent(opts.transactionId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    detail.txStatus = r.status
    if (!r.ok) return none
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown>
    const order = (d.order || {}) as Record<string, unknown>
    return {
      ok: true,
      paid: d.success === true && d.pending !== true && d.is_voided !== true && d.is_refunded !== true,
      amountCents: toNum(d.amount_cents),
      specialReference: String(order.merchant_order_id || ''),
      source: 'transaction',
      detail: { ...detail, success: d.success, pending: d.pending },
    }
  } catch (e) {
    detail.error = String(e)
    return none
  }
}

/** Brute-force which HMAC scheme Paymob actually used, given a full captured callback `body` and the
 *  candidate signatures it carried. Tries several objects × field orders × boolean reprs × algorithms
 *  × encodings with the configured secret and returns the matching descriptor(s). Lets us pin the
 *  exact Unified-Checkout signature from ONE captured payload — no repeated test payments. TEMP. */
export function findHmacScheme(body: unknown, candidates: { name: string; value: string }[]): string[] {
  if (!HMAC_SECRET) return ['NO_HMAC_SECRET']
  const b = (body ?? {}) as Record<string, unknown>
  const sortedScalars = (o: Record<string, unknown>, r: (v: unknown) => string) =>
    Object.keys(o)
      .filter((k) => { const v = o[k]; return v === null || ['string', 'number', 'boolean'].includes(typeof v) })
      .sort()
      .map((k) => r(o[k]))
      .join('')
  const objects: [string, unknown][] = [
    ['transaction', b.transaction], ['obj', b.obj], ['intention', b.intention], ['root', b],
  ]
  const cands = candidates
    .filter((c) => c && c.value)
    .map((c) => ({ name: c.name, raw: String(c.value), low: String(c.value).toLowerCase() }))
  const algos = ['sha512', 'sha256'] as const
  const hits: string[] = []
  for (const [oname, o] of objects) {
    if (!o || typeof o !== 'object') continue
    const rec = o as Record<string, unknown>
    const bases: [string, string][] = [
      ['classic:std', transactionHmacFields(rec).map(([, v]) => reprStd(v)).join('')],
      ['classic:py', transactionHmacFields(rec).map(([, v]) => reprPy(v)).join('')],
      ['sorted:std', sortedScalars(rec, reprStd)],
      ['sorted:py', sortedScalars(rec, reprPy)],
    ]
    for (const [bname, basis] of bases) {
      if (!basis) continue
      for (const algo of algos) {
        const hex = crypto.createHmac(algo, HMAC_SECRET).update(basis).digest('hex')
        const b64 = crypto.createHmac(algo, HMAC_SECRET).update(basis).digest('base64')
        for (const c of cands) {
          if (hex === c.low) hits.push(`${oname}/${bname}/${algo}/hex == ${c.name}`)
          else if (b64 === c.raw) hits.push(`${oname}/${bname}/${algo}/base64 == ${c.name}`)
        }
      }
    }
  }
  return hits.length ? hits : ['NO_SCHEME_MATCHED']
}
