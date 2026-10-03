// HTTP client for Flash (useflash.app). Thin on purpose — every decision lives
// in flash-core.ts where it can be unit-tested; this file only moves bytes.
//
//   POST /v1/auth/token                  Basic client_id:client_secret → bearer (24h)
//   POST /v1/orders                      create a checkout → {order, paymentLink}
//   GET  /v1/orders/aggregator/:ourId    read one back, with its status
//   POST /v1/orders/cancel               close a still-pending checkout
import {
  basicAuthHeader,
  buildOrderBody,
  errorCodeOf,
  errorMessageOf,
  flashSettingsFrom,
  parseOrderResponse,
} from './flash-core'
import type { FlashOrderInput, FlashOrderView, FlashSettings } from './flash-core'

const TIMEOUT_MS = 15_000

/** A refusal from Flash, carrying its error code (e.g. ORDER_BELOW_MINIMUM). */
export class FlashApiError extends Error {
  constructor(message: string, public status: number, public code: string | null) {
    super(message)
    this.name = 'FlashApiError'
  }
}

export function flashSettings(): FlashSettings | null {
  return flashSettingsFrom(process.env)
}

/** Whether the server has everything it needs to take Flash payments. */
export function isFlashConfigured(): boolean {
  return flashSettings() !== null
}

function requireSettings(): FlashSettings {
  const s = flashSettings()
  if (!s) throw new FlashApiError('Flash payments are not configured', 503, 'NOT_CONFIGURED')
  return s
}

// One token per warm lambda. Flash issues them for 24h; we refresh a minute
// early so a request never goes out with one that expires in flight.
let cached: { token: string; expiresAt: number; key: string } | null = null

async function call(path: string, init: RequestInit & { auth: string }, s: FlashSettings): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${s.baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: init.auth },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json }
}

async function accessToken(s: FlashSettings, force = false): Promise<string> {
  const key = `${s.baseUrl}|${s.clientId}`
  if (!force && cached && cached.key === key && cached.expiresAt > Date.now() + 60_000) return cached.token
  const { status, json } = await call('/v1/auth/token', { method: 'POST', auth: basicAuthHeader(s.clientId, s.clientSecret) }, s)
  const j = (json ?? {}) as Record<string, unknown>
  if (status !== 200 || typeof j.access_token !== 'string') {
    // 401 with an empty body is Flash's answer to wrong credentials.
    throw new FlashApiError(`Flash auth failed (HTTP ${status})`, status, errorCodeOf(json))
  }
  const ttl = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600
  cached = { token: j.access_token, expiresAt: Date.now() + ttl * 1000, key }
  return j.access_token
}

/** An authenticated call, retried once with a fresh token if Flash says 401. */
async function authed(path: string, init: RequestInit, s: FlashSettings) {
  let r = await call(path, { ...init, auth: `Bearer ${await accessToken(s)}` }, s)
  if (r.status === 401) r = await call(path, { ...init, auth: `Bearer ${await accessToken(s, true)}` }, s)
  return r
}

/** Create a checkout. Throws FlashApiError on any refusal. */
export async function createFlashOrder(input: Omit<FlashOrderInput, 'integrationId'>): Promise<FlashOrderView> {
  const s = requireSettings()
  const body = buildOrderBody({ ...input, integrationId: s.integrationId })
  const { status, json } = await authed('/v1/orders', { method: 'POST', body: JSON.stringify(body) }, s)
  const order = parseOrderResponse(json)
  if (status >= 300 || !order || !order.paymentLink) {
    const code = errorCodeOf(json)
    const msg = errorMessageOf(json)
    throw new FlashApiError(`Flash refused the order${code ? ` (${code})` : ''}${msg ? `: ${msg}` : ''} — HTTP ${status}`, status, code)
  }
  return order
}

/** Read one checkout by OUR id. null when Flash has never heard of it. */
export async function getFlashOrder(aggregatorOrderId: string): Promise<FlashOrderView | null> {
  const s = requireSettings()
  const { status, json } = await authed(`/v1/orders/aggregator/${encodeURIComponent(aggregatorOrderId)}`, { method: 'GET' }, s)
  if (errorCodeOf(json) === 'ORDER_NOT_FOUND') return null
  if (status >= 300) throw new FlashApiError(`Flash order lookup failed — HTTP ${status}`, status, errorCodeOf(json))
  return parseOrderResponse(json)
}

/**
 * Close a still-pending checkout so an old link can't be paid after a new one
 * was issued. Best-effort by design: Flash refuses (INVALID_STATUS) once the
 * order is no longer pending, and that is fine — the caller reads the status
 * back and a success still counts.
 */
export async function cancelFlashOrder(aggregatorOrderId: string, reason: string): Promise<boolean> {
  const s = requireSettings()
  const { status } = await authed('/v1/orders/cancel', {
    method: 'POST',
    body: JSON.stringify({ merchantOrderId: aggregatorOrderId, reason }),
  }, s)
  return status < 300
}
