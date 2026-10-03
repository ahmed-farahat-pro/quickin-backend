// Pure Flash (useflash.app) payment logic: the webhook signature, the status
// vocabulary, the order body, and the rules for reusing a checkout.
//
// Flash is the one AUTOMATIC way to pay. Instapay and bank transfer are manual —
// the guest sends money elsewhere and uploads a screenshot an admin reviews.
// Flash instead hands us a hosted payment link (card or wallet); the guest pays
// there and Flash tells us the outcome, by webhook and by a status read.
//
// Free of RELATIVE imports, so `node --test` can load it directly — see README →
// Testing. `node:crypto` is a builtin, which the ESM resolver is happy with.
// flash.ts (the HTTP client) and db.ts import this; never the reverse.
import { createHmac, timingSafeEqual } from 'node:crypto'

// ---- Configuration ----------------------------------------------------------

/** Flash's documented production host. Staging is https://stg-api.useflash.app. */
export const FLASH_DEFAULT_BASE_URL = 'https://beta-api.useflash.app'

export interface FlashSettings {
  baseUrl: string
  clientId: string
  clientSecret: string
  integrationId: number
  hmacSecret: string
}

/**
 * The credentials from FLASH_CLIENT_ID, FLASH_CLIENT_SECRET, FLASH_INTEGRATION_ID
 * and FLASH_HMAC_SECRET (+ optional FLASH_BASE_URL), or null when any is missing. All four are required: without
 * the HMAC secret a webhook can't be told apart from a forgery, and a method we
 * can't confirm automatically has no business being offered as automatic.
 */
export function flashSettingsFrom(env: Record<string, string | undefined>): FlashSettings | null {
  const clientId = String(env.FLASH_CLIENT_ID ?? '').trim()
  const clientSecret = String(env.FLASH_CLIENT_SECRET ?? '').trim()
  const hmacSecret = String(env.FLASH_HMAC_SECRET ?? '').trim()
  const integrationId = Number(String(env.FLASH_INTEGRATION_ID ?? '').trim())
  if (!clientId || !clientSecret || !hmacSecret) return null
  if (!Number.isSafeInteger(integrationId) || integrationId <= 0) return null
  const baseUrl = (String(env.FLASH_BASE_URL ?? '').trim() || FLASH_DEFAULT_BASE_URL).replace(/\/+$/, '')
  return { baseUrl, clientId, clientSecret, integrationId, hmacSecret }
}

/** `Authorization: Basic base64(client_id:client_secret)` for POST /v1/auth/token. */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`
}

// ---- Money ------------------------------------------------------------------

/** Flash refuses orders under 5 EGP (ORDER_BELOW_MINIMUM). */
export const FLASH_MIN_AMOUNT_CENTS = 500

/** EGP → piastres. Rounded, because 0.1 + 0.2 must not become 30.000000000000004 cents. */
export function toAmountCents(egp: unknown): number {
  const n = Number(egp)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * 100)
}

// ---- Orders -----------------------------------------------------------------

/**
 * How long a checkout link stays payable. Short on purpose: the price is the
 * booking's price at the moment the link was minted, and a link left in a tab for
 * a day is a link for a stale amount. 30 minutes is plenty to type a card number.
 */
export const FLASH_ORDER_VALIDITY_SECONDS = 30 * 60

/**
 * A link with less than this left is not handed out again — the guest would
 * open it and be cut off mid-payment.
 */
export const FLASH_REUSE_MARGIN_SECONDS = 5 * 60

/**
 * Our id for one checkout ATTEMPT (Flash's `aggregatorOrderId`).
 *
 * Unique per attempt, not per booking: a guest whose link expired needs a new
 * order, and Flash staging was observed (2026-10-03) to accept a duplicate id
 * silently rather than answering DUPLICATE_ORDER as documented — then its
 * lookup-by-id returns only the newest. A fresh id per attempt makes every
 * lookup unambiguous whatever Flash does.
 */
export function buildAggregatorOrderId(bookingId: string, nowMs: number, nonce = ''): string {
  const n = String(nonce).replace(/[^a-z0-9]/gi, '').slice(0, 6)
  return `qk-${bookingId}-${Math.max(0, Math.floor(nowMs)).toString(36)}${n ? `-${n}` : ''}`
}

export interface FlashOrderInput {
  integrationId: number
  aggregatorOrderId: string
  amountCents: number
  bookingId: string
  description?: string
  reservationCode?: string | null
  customerName?: string | null
  customerPhone?: string | null
  validitySeconds?: number
}

/**
 * The POST /v1/orders body.
 *
 * `webEnabled: true` is the important flag: the guest pays on Flash's web page
 * with a card or wallet, without having to install the Flash app first.
 * `orderType: 'online'` — never `call_center`, which makes Flash SMS the guest a
 * link of its own and would duplicate the one we already show.
 */
export function buildOrderBody(i: FlashOrderInput): Record<string, unknown> {
  const additionalInfo = [{ key: 'booking_id', value: i.bookingId }]
  if (i.reservationCode) additionalInfo.push({ key: 'reservation_code', value: String(i.reservationCode) })
  const body: Record<string, unknown> = {
    integrationId: i.integrationId,
    aggregatorOrderId: i.aggregatorOrderId,
    amountCents: i.amountCents,
    currency: 'EGP',
    orderType: 'online',
    webEnabled: true,
    merchantName: 'QuickIn',
    validity: i.validitySeconds ?? FLASH_ORDER_VALIDITY_SECONDS,
    description: String(i.description ?? '').slice(0, 200),
    additionalInfo,
  }
  // Flash refuses a `customer` without a phone ("invalid: phone (field
  // required)", observed on staging 2026-10-03), so a guest who never gave us a
  // number gets no customer object at all rather than a failed checkout.
  const phone = String(i.customerPhone ?? '').trim()
  if (phone) {
    const customer: Record<string, string> = { phone }
    const name = String(i.customerName ?? '').trim()
    if (name) customer.name = name.slice(0, 120)
    body.customer = customer
  }
  return body
}

// ---- Status -----------------------------------------------------------------

/** Our `flash_orders.status`. Flash's vocabulary, lowercased, plus `expired`. */
export const FLASH_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'canceled', 'refunded', 'expired'] as const
export type FlashStatus = (typeof FLASH_STATUSES)[number]

/**
 * Flash's status, in any case it chooses to send — the webhook says `SUCCEEDED`,
 * the order API says `succeeded`, and the docs spell the last one `canceled`.
 * Anything unrecognised is `pending`: an unknown word must never be read as paid,
 * and must never close a checkout either.
 */
export function normalizeFlashStatus(value: unknown): FlashStatus {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'cancelled') return 'canceled'
  if (v === 'success' || v === 'paid') return 'succeeded'
  return (FLASH_STATUSES as readonly string[]).includes(v) ? (v as FlashStatus) : 'pending'
}

/** Still waiting on the guest — the only states a link is worth reusing in. */
export function isOpenFlashStatus(s: FlashStatus): boolean {
  return s === 'pending' || s === 'processing'
}

/**
 * Whether a status may replace the one we hold.
 *
 * Money only moves forward: once `succeeded`, only `refunded` may follow. This
 * is what makes the webhook and the status poll safe to race — a late `pending`
 * from a slow poll can never un-pay a booking the webhook already paid.
 */
export function canTransition(from: FlashStatus, to: FlashStatus): boolean {
  if (from === to) return false
  if (from === 'refunded') return false
  if (from === 'succeeded') return to === 'refunded'
  if (isOpenFlashStatus(to)) return isOpenFlashStatus(from) && to === 'processing'
  return true
}

export interface StoredFlashOrder {
  status: string
  amount_cents: number
  payment_link: string | null
  expires_at: string | Date | null
}

/**
 * Whether the guest's last link can be handed out again instead of minting a new
 * order. Only an open order, for the SAME amount (the price may have changed since —
 * e.g. the commission rate), with enough life left to finish paying.
 */
export function canReuseOrder(o: StoredFlashOrder | null | undefined, amountCents: number, nowMs: number): boolean {
  if (!o || !o.payment_link) return false
  if (!isOpenFlashStatus(normalizeFlashStatus(o.status))) return false
  if (Number(o.amount_cents) !== amountCents) return false
  const exp = o.expires_at ? new Date(o.expires_at).getTime() : NaN
  return Number.isFinite(exp) && exp - nowMs > FLASH_REUSE_MARGIN_SECONDS * 1000
}

/**
 * Whether a reported success actually covers the order. `paid` comes from the
 * webhook's `paidAmountCents`, which may be absent on an order read — absent
 * means "Flash says succeeded and gave no figure", which we accept, since the
 * order itself was created for exactly `expected`.
 */
export function paidEnough(expectedCents: number, paidCents: unknown): boolean {
  if (paidCents === undefined || paidCents === null || paidCents === '') return true
  const n = Number(paidCents)
  return Number.isFinite(n) && n >= expectedCents
}

// ---- What an order read / webhook says --------------------------------------

export interface FlashOrderView {
  /** Flash's own order id (a uuid). */
  id: string | null
  aggregatorOrderId: string | null
  status: FlashStatus
  amountCents: number | null
  paidAmountCents: number | null
  paymentLink: string | null
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function strOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return s ? s : null
}

/** Read `{order: {...}}` from POST /v1/orders or GET /v1/orders/aggregator/:id. */
export function parseOrderResponse(json: unknown): FlashOrderView | null {
  const root = (json ?? {}) as Record<string, unknown>
  const o = (root.order ?? null) as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  return {
    id: strOrNull(o.id),
    aggregatorOrderId: strOrNull(o.aggregatorOrderId ?? o.merchantOrderId),
    status: normalizeFlashStatus(o.status),
    amountCents: numOrNull(o.amountCents),
    paidAmountCents: null,
    paymentLink: strOrNull(root.paymentLink ?? o.paymentLink),
  }
}

/** Read a transaction-notification webhook body. */
export function parseWebhook(json: unknown): FlashOrderView | null {
  const w = (json ?? {}) as Record<string, unknown>
  if (!w || typeof w !== 'object') return null
  const order = (w.order ?? {}) as Record<string, unknown>
  const aggregatorOrderId = strOrNull(w.aggregatorOrderId ?? w.merchantOrderId)
  if (!aggregatorOrderId) return null
  return {
    id: strOrNull(order.id),
    aggregatorOrderId,
    status: normalizeFlashStatus(w.status),
    amountCents: numOrNull(order.amountCents),
    paidAmountCents: numOrNull(w.paidAmountCents),
    paymentLink: strOrNull(order.paymentLink),
  }
}

/** Flash's error code from a 4xx body: `{error: {code, message}}`. */
export function errorCodeOf(json: unknown): string | null {
  const e = ((json ?? {}) as Record<string, unknown>).error as Record<string, unknown> | undefined
  return e && typeof e === 'object' ? strOrNull(e.code) : null
}

/**
 * Flash's error message. Worth logging: a validation failure comes back with a
 * message and NO code (`{error: {message: "invalid: phone (field required)"}}`).
 */
export function errorMessageOf(json: unknown): string | null {
  const e = ((json ?? {}) as Record<string, unknown>).error as Record<string, unknown> | undefined
  return e && typeof e === 'object' ? strOrNull(e.message) : null
}

// ---- Webhook signature ------------------------------------------------------
//
// Flash signs a webhook by flattening the JSON body, dropping empty values,
// sorting the keys, joining `key=value` pairs with commas, and taking
// HMAC-SHA256 of that string with the shared secret, as hex. Their spec asks for
// it to be done generically so a field they add later can't break verification —
// so nothing below names a field.

/**
 * `{order: {customer: {name}}}` → `{"order.customer.name": "…"}`.
 *
 * Arrays are flattened by index (`items.0.sku`). Flash's spec has no array in a
 * signed payload; indexing is the generic choice that keeps every value in the
 * signature rather than silently dropping it.
 */
export function flattenForSignature(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (value === null || value === undefined) return out
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenForSignature(v, prefix ? `${prefix}.${i}` : String(i), out))
    return out
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenForSignature(v, prefix ? `${prefix}.${k}` : k, out)
    }
    return out
  }
  const s = String(value)
  // Step 2 of the spec: "omit any empty keys".
  if (s === '' || !prefix) return out
  out[prefix] = s
  return out
}

/** Steps 1–4: the exact string that gets signed. */
export function signaturePayload(body: unknown): string {
  const flat = flattenForSignature(body)
  return Object.keys(flat)
    .sort()
    .map((k) => `${k}=${flat[k]}`)
    .join(',')
}

/** Step 5: hex HMAC-SHA256 of the payload string. */
export function computeSignature(body: unknown, secret: string): string {
  return createHmac('sha256', secret).update(signaturePayload(body), 'utf8').digest('hex')
}

/**
 * Constant-time check of the `signature` header. Accepts upper- or lower-case
 * hex and an optional `sha256=` prefix — a formatting difference is not a forgery.
 */
export function verifySignature(body: unknown, header: string | null | undefined, secret: string): boolean {
  if (!secret) return false
  const got = String(header ?? '').trim().replace(/^sha256=/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(got)) return false
  const want = computeSignature(body, secret)
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'))
}
