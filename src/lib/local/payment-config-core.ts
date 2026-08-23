// Pure payment-destination logic: the app_settings keys that make up every
// guest-facing way to pay, plus the validators the admin PUT routes run.
//
// There are two destinations, each independently toggleable from /ops/payments:
//   • instapay      — a handle, an optional deep link and an optional QR
//   • bank_transfer — a bank name, an account holder, an account number and an
//                     optional IBAN
//
// No runtime imports, so `node --test` can import this file directly — see
// CLAUDE.md → "Standing requirement — docs and tests". db.ts imports this
// module; this module never imports db.ts. That constraint is also why the IBAN
// checksum below is a copy of the one in payout-method-core rather than an
// import: Node's ESM resolver rejects the extension-less relative specifiers the
// rest of src/lib/local uses, so a shared core must have no relative imports at
// all. The two copies validate the same standard and are expected to agree.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// write the same Neon rows. scripts/check-payment-config-core-parity.mjs fails
// if they drift, so edit one copy and paste it over the other verbatim.

/** The ways a guest can pay. `payment_proofs.method` stores one of these. */
export const PAYMENT_METHODS = ['instapay', 'bank_transfer'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(String(value))
}

/**
 * The method a client claims it used. Anything unrecognised falls back to
 * 'instapay' — the column is plain text with no CHECK constraint, and a typo
 * from an old client should land on the original method rather than poison the
 * queue with a value no reviewer's UI knows how to label.
 */
export function normalizePaymentMethod(value: unknown): PaymentMethod {
  const v = String(value ?? '').trim().toLowerCase()
  return isPaymentMethod(v) ? v : 'instapay'
}

/** The app_settings rows that make up the Instapay destination. */
export const INSTAPAY_KEYS = {
  enabled: 'instapay_enabled',
  handle: 'instapay_handle',
  instructions: 'instapay_instructions',
  link: 'instapay_link',
  qr: 'instapay_qr_image',
} as const

/** The app_settings rows that make up the bank-transfer destination. */
export const BANK_KEYS = {
  enabled: 'bank_transfer_enabled',
  bankName: 'bank_name',
  accountName: 'bank_account_name',
  accountNumber: 'bank_account_number',
  iban: 'bank_iban',
  instructions: 'bank_instructions',
} as const

/** Every key getPaymentConfig() reads in one query. */
export const PAYMENT_SETTING_KEYS: readonly string[] = [
  ...Object.values(INSTAPAY_KEYS),
  ...Object.values(BANK_KEYS),
]

export const MAX_HANDLE_CHARS = 200
export const MAX_INSTRUCTIONS_CHARS = 2000
export const MAX_LINK_CHARS = 500
/** A QR is a small flat graphic; ~500KB of base64 is already far more than one needs. */
export const MAX_QR_CHARS = 700_000
export const MAX_BANK_NAME_CHARS = 120
export const MAX_ACCOUNT_NAME_CHARS = 120
export const MAX_ACCOUNT_NUMBER_CHARS = 34
export const MAX_IBAN_CHARS = 34

export interface BankConfig {
  /** Whether the admin wants guests to see this method at all. */
  enabled: boolean
  /** e.g. "Banque Misr". Without it an account number names nothing. */
  bank_name: string
  /** The beneficiary name. Egyptian banking apps check it against the account. */
  account_name: string
  account_number: string
  /** Optional — an account number plus the bank is enough for a domestic transfer. */
  iban: string
  /** `iban` in groups of four, derived at read time and never stored. */
  iban_formatted: string
  instructions: string
  /** Whether a guest actually has enough to complete a transfer. */
  configured: boolean
}

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
  instapay_enabled: boolean
  bank: BankConfig
  /**
   * The methods to offer, in the order to offer them: enabled AND configured.
   * A client should render a picker from this and never hardcode the list — that
   * is what keeps an admin's toggle meaningful on a build that shipped months ago.
   */
  available_methods: PaymentMethod[]
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

// ---- Stored booleans --------------------------------------------------------

/**
 * How a toggle is written. Plain '1'/'0' rather than JSON so the value stays
 * readable in a `SELECT * FROM app_settings` during an incident.
 */
export function boolToStored(on: unknown): string {
  return on ? '1' : '0'
}

/**
 * How a toggle is read. **A missing or empty row means ON.** Both methods
 * predate their own toggle — Instapay by a year — so a database that has never
 * seen these keys must keep showing what it was showing. A method with nothing
 * filled in is hidden by `configured`, not by the toggle, so defaulting to on
 * cannot expose an empty destination.
 */
export function storedToBool(value: unknown): boolean {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return true
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off')
}

// ---- Instapay validators ----------------------------------------------------

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

// ---- Bank-transfer validators ----------------------------------------------

/** Collapse runs of whitespace so "Banque   Misr" and "Banque Misr" are one value. */
function squash(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

export function normalizeBankName(v: unknown): string {
  return squash(v).slice(0, MAX_BANK_NAME_CHARS)
}

export function normalizeAccountName(v: unknown): string {
  return squash(v).slice(0, MAX_ACCOUNT_NAME_CHARS)
}

/**
 * The account number as the bank prints it. Kept WHOLE and unmasked — the whole
 * point of this value is that a guest types it into their banking app, and a
 * masked one is one nobody can send money to. Same principle as the host payout
 * IBAN.
 *
 * Egyptian account numbers vary in length and some banks group them with dashes
 * or slashes, so the shape is checked rather than the length.
 */
export function normalizeAccountNumber(v: unknown): string {
  const s = squash(v).toUpperCase()
  if (!s) return ''
  if (s.length > MAX_ACCOUNT_NUMBER_CHARS) {
    throw new PaymentConfigError(`An account number is at most ${MAX_ACCOUNT_NUMBER_CHARS} characters`)
  }
  if (!/^[A-Z0-9][A-Z0-9 \-/]*[A-Z0-9]$/.test(s)) {
    throw new PaymentConfigError('An account number is letters and digits, optionally split by spaces, - or /')
  }
  if (!/\d/.test(s)) {
    throw new PaymentConfigError('That account number has no digits in it — please check it')
  }
  return s
}

/**
 * Country-code → total IBAN length. The region plus the majors; a country that
 * is not listed passes on the checksum alone rather than being refused, so an
 * unusual but valid IBAN is never blocked by an incomplete table.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  EG: 29, SA: 24, AE: 23, KW: 30, QA: 29, BH: 22, OM: 23, JO: 30, LB: 28,
  MA: 28, TN: 24, DZ: 26, LY: 25, SD: 18, IQ: 23, PS: 29,
  GB: 22, IE: 22, FR: 27, DE: 22, IT: 27, ES: 24, PT: 25, NL: 18, BE: 16,
  CH: 21, AT: 20, SE: 24, NO: 15, DK: 18, FI: 18, PL: 28, GR: 27, TR: 26,
  RO: 24, CZ: 24, HU: 28, PK: 24,
}

/** ISO 7064 mod-97-10. A transposition can survive a length check but not this. */
export function ibanChecksumValid(compact: string): boolean {
  const s = String(compact ?? '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    // A→10 … Z→35; a letter contributes two digits, a digit one.
    const value = ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : Number(ch)
    if (Number.isNaN(value)) return false
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97
  }
  return remainder === 1
}

/**
 * The optional IBAN. Empty clears it. Both the country length AND the checksum
 * are enforced, because a transposed digit can satisfy one of them alone.
 */
export function normalizeBankIban(v: unknown): string {
  const s = String(v ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (!s) return ''
  if (s.length < 15 || s.length > MAX_IBAN_CHARS) {
    throw new PaymentConfigError('That IBAN is not the right length')
  }
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) {
    throw new PaymentConfigError('An IBAN starts with two letters and two digits, like EG38…')
  }
  const expected = IBAN_LENGTHS[s.slice(0, 2)]
  if (expected && s.length !== expected) {
    throw new PaymentConfigError(`An IBAN for ${s.slice(0, 2)} is ${expected} characters — that one is ${s.length}`)
  }
  if (!ibanChecksumValid(s)) {
    throw new PaymentConfigError("That IBAN doesn't look right — please check it")
  }
  return s
}

/** An IBAN in groups of four, the way every bank prints one. Never stored. */
export function formatIban(v: unknown): string {
  const s = String(v ?? '').replace(/\s/g, '').toUpperCase()
  return s ? (s.match(/.{1,4}/g) ?? []).join(' ') : ''
}

export interface BankFields {
  bank_name: string
  account_name: string
  account_number: string
  iban: string
}

/**
 * Whether a guest has enough to actually complete a transfer.
 *
 * All three of bank, beneficiary and a number are required. The beneficiary name
 * is not decoration: Egyptian banking apps ask for it and reject a mismatch, so
 * a destination missing it would send guests into a failed transfer. An IBAN
 * counts as the number — a guest paying by IBAN never needs the account number.
 */
export function isBankConfigured(b: BankFields): boolean {
  return Boolean(b.bank_name.trim() && b.account_name.trim() && (b.account_number.trim() || b.iban.trim()))
}

/**
 * What the ops panel tells an admin is still missing, or '' when nothing is.
 * Returns '' for a completely empty bank block too — an untouched method is not
 * an incomplete one, and nagging about it would be noise on a screen whose main
 * job is Instapay.
 */
export function bankConfigGap(b: BankFields): string {
  const empty = !b.bank_name.trim() && !b.account_name.trim() && !b.account_number.trim() && !b.iban.trim()
  if (empty || isBankConfigured(b)) return ''
  const missing: string[] = []
  if (!b.bank_name.trim()) missing.push('the bank name')
  if (!b.account_name.trim()) missing.push('the account holder name')
  if (!b.account_number.trim() && !b.iban.trim()) missing.push('an account number or IBAN')
  return `Not shown to guests yet — still needs ${missing.join(', ')}.`
}

// ---- Assembly ---------------------------------------------------------------

/** Build the guest-facing config from raw `app_settings` rows (missing ⇒ ''). */
export function rowsToPaymentConfig(rows: Array<{ key: string; value: string | null }>): PaymentConfig {
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value ?? ''
  const has = (k: string) => Object.prototype.hasOwnProperty.call(map, k)
  const instapay_handle = (map[INSTAPAY_KEYS.handle] ?? '').trim()
  const instapay_link = (map[INSTAPAY_KEYS.link] ?? '').trim()

  const fields: BankFields = {
    bank_name: (map[BANK_KEYS.bankName] ?? '').trim(),
    account_name: (map[BANK_KEYS.accountName] ?? '').trim(),
    account_number: (map[BANK_KEYS.accountNumber] ?? '').trim(),
    iban: (map[BANK_KEYS.iban] ?? '').trim(),
  }
  const bank: BankConfig = {
    ...fields,
    // `has` matters: an explicitly stored '' is still "never set", and storedToBool
    // reads both as on. Written out so the intent survives a later refactor.
    enabled: storedToBool(has(BANK_KEYS.enabled) ? map[BANK_KEYS.enabled] : ''),
    iban_formatted: formatIban(fields.iban),
    instructions: map[BANK_KEYS.instructions] ?? '',
    configured: isBankConfigured(fields),
  }

  const cfg: PaymentConfig = {
    instapay_handle,
    instructions: map[INSTAPAY_KEYS.instructions] ?? '',
    instapay_link,
    instapay_qr_image: (map[INSTAPAY_KEYS.qr] ?? '').trim(),
    qr_payload: qrPayload(instapay_handle, instapay_link),
    instapay_enabled: storedToBool(has(INSTAPAY_KEYS.enabled) ? map[INSTAPAY_KEYS.enabled] : ''),
    bank,
    available_methods: [],
  }
  cfg.available_methods = availableMethods(cfg)
  return cfg
}

/** True once a guest has somewhere to send money — a handle or a link is enough. */
export function isInstapayConfigured(cfg: PaymentConfig): boolean {
  return Boolean(cfg.instapay_handle || cfg.instapay_link)
}

/** Enabled AND configured, in the order the clients render the picker. */
export function availableMethods(cfg: PaymentConfig): PaymentMethod[] {
  const out: PaymentMethod[] = []
  if (cfg.instapay_enabled && isInstapayConfigured(cfg)) out.push('instapay')
  if (cfg.bank.enabled && cfg.bank.configured) out.push('bank_transfer')
  return out
}

/**
 * True once there is any way to pay at all.
 *
 * This used to mean "Instapay has a handle or a link". It now means what its name
 * always claimed — callers asking "can this guest pay?" want either method to
 * count. `isInstapayConfigured` is the old, narrower question.
 */
export function isPaymentConfigured(cfg: PaymentConfig): boolean {
  return availableMethods(cfg).length > 0
}
