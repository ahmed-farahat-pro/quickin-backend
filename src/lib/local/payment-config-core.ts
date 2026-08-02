// Pure Instapay payment-config logic: the app_settings keys that make up the
// guest-facing destination, plus the validators the admin PUT route runs.
//
// No runtime imports, so `node --test` can import this file directly — see
// CLAUDE.md → "Standing requirement — docs and tests". db.ts imports this
// module; this module never imports db.ts.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// write the same Neon rows. scripts/check-payment-config-core-parity.mjs fails
// if they drift, so edit one copy and paste it over the other verbatim.

/** The four app_settings rows that make up the Instapay destination. */
export const INSTAPAY_KEYS = {
  handle: 'instapay_handle',
  instructions: 'instapay_instructions',
  link: 'instapay_link',
  qr: 'instapay_qr_image',
} as const

export const MAX_HANDLE_CHARS = 200
export const MAX_INSTRUCTIONS_CHARS = 2000
export const MAX_LINK_CHARS = 500
/** A QR is a small flat graphic; ~500KB of base64 is already far more than one needs. */
export const MAX_QR_CHARS = 700_000

export interface PaymentConfig {
  /** The Instapay address/number guests transfer to, e.g. `someone@instapay`. */
  instapay_handle: string
  instructions: string
  /** Optional ipn.eg (or bank) deep link that opens Instapay directly. */
  instapay_link: string
  /** Optional admin-uploaded QR, as a base64 data URL (World-1 image convention). */
  instapay_qr_image: string
  /** What a client should encode when it has to draw the QR itself — see qrPayload(). */
  qr_payload: string
}

/** Thrown for admin input a human should fix; routes map it to HTTP 400. */
export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentConfigError'
  }
}

/** Cross-realm-safe check (routes may see an error thrown in another bundle). */
export function isPaymentConfigError(e: unknown): e is PaymentConfigError {
  return e instanceof Error && e.name === 'PaymentConfigError'
}

export function normalizeHandle(v: unknown): string {
  return String(v ?? '').trim().slice(0, MAX_HANDLE_CHARS)
}

export function normalizeInstructions(v: unknown): string {
  return String(v ?? '').trim().slice(0, MAX_INSTRUCTIONS_CHARS)
}

/**
 * An Instapay deep link, e.g. `https://ipn.eg/S/someone/instapay/ABC123`. Empty
 * clears it. http(s) only: the guest UIs render this inside an anchor, so a
 * `javascript:` or `data:` URL here would be a stored-XSS vector.
 */
export function normalizeInstapayLink(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (s.length > MAX_LINK_CHARS) throw new PaymentConfigError('That Instapay link is too long')
  if (!/^https?:\/\/[^\s]+$/i.test(s)) {
    throw new PaymentConfigError('The Instapay link must start with http:// or https://')
  }
  return s
}

/**
 * The admin-uploaded QR, as a base64 data URL or an https URL. Empty clears it,
 * which makes the guest clients fall back to drawing a QR from `qr_payload`.
 *
 * SVG is deliberately excluded: it is the one image type that can carry markup,
 * and this value is rendered back into the ops panel as well as to guests.
 */
export function normalizeQrImage(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const isDataUrl = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(s)
  if (!isDataUrl && !/^https:\/\/[^\s]+$/i.test(s)) {
    throw new PaymentConfigError('The QR code must be a PNG, JPEG, GIF or WebP image')
  }
  if (s.length > MAX_QR_CHARS) throw new PaymentConfigError('That QR image is too large (max ~500KB)')
  return s
}

/**
 * What a client encodes when no QR image was uploaded: the link if there is one
 * (scanning it opens Instapay), else the raw handle. Empty ⇒ draw nothing.
 */
export function qrPayload(handle: string, link: string): string {
  return String(link ?? '').trim() || String(handle ?? '').trim()
}

/** Build the guest-facing config from raw `app_settings` rows (missing ⇒ ''). */
export function rowsToPaymentConfig(rows: Array<{ key: string; value: string | null }>): PaymentConfig {
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value ?? ''
  const instapay_handle = (map[INSTAPAY_KEYS.handle] ?? '').trim()
  const instapay_link = (map[INSTAPAY_KEYS.link] ?? '').trim()
  return {
    instapay_handle,
    instructions: map[INSTAPAY_KEYS.instructions] ?? '',
    instapay_link,
    instapay_qr_image: (map[INSTAPAY_KEYS.qr] ?? '').trim(),
    qr_payload: qrPayload(instapay_handle, instapay_link),
  }
}

/** True once a guest has somewhere to send money — a handle or a link is enough. */
export function isPaymentConfigured(cfg: PaymentConfig): boolean {
  return Boolean(cfg.instapay_handle || cfg.instapay_link)
}
