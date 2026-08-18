// Host payout methods — where QuickIn sends a host's earnings.
//
// A host picks exactly ONE preferred destination from three: a bank account, an
// InstaPay address, or a mobile wallet. This module validates what they submit
// and derives the one-liner their profile shows back, so the same rules apply on
// the website, on iOS and on Android.
//
// All three are stored WHOLE, because all three are the payout destination and
// someone has to be able to send money to them. That is why this replaced an
// earlier credit-card option: a card number cannot be paid out without a
// processor token, and holding one would have put this database in PCI-DSS
// scope for nothing. Bank details carry no such restriction — an IBAN is meant
// to be handed out — so they are kept in full and shown back in full, which is
// also what lets a host confirm they typed them correctly.
//
// No runtime imports, so `node --test` can import this file directly — see
// CLAUDE.md → "Standing requirement — docs and tests". db.ts imports the core,
// never the reverse.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// write the same Neon rows. scripts/check-payout-method-core-parity.mjs fails if
// they drift, so edit one copy and paste it over the other verbatim.

/** The payout destinations a host may choose between. Stored in `host_payout_methods.method`. */
export const PAYOUT_METHODS = [
  { key: 'bank_account', label: 'Bank account' },
  { key: 'instapay', label: 'InstaPay' },
  { key: 'wallet', label: 'Wallet' },
] as const

export type PayoutMethod = (typeof PAYOUT_METHODS)[number]['key']

const PAYOUT_METHOD_KEYS = new Set<string>(PAYOUT_METHODS.map((m) => m.key))

/** Mobile wallets a host can be paid into. 'other' keeps an unlisted one usable. */
export const WALLET_PROVIDERS = [
  { key: 'vodafone_cash', label: 'Vodafone Cash' },
  { key: 'etisalat_cash', label: 'Etisalat Cash' },
  { key: 'orange_money', label: 'Orange Money' },
  { key: 'we_pay', label: 'WE Pay' },
  { key: 'other', label: 'Other wallet' },
] as const

export type WalletProvider = (typeof WALLET_PROVIDERS)[number]['key']

const WALLET_PROVIDER_KEYS = new Set<string>(WALLET_PROVIDERS.map((p) => p.key))

export const MAX_ACCOUNT_NAME_CHARS = 120
export const MAX_INSTAPAY_ADDRESS_CHARS = 120
export const MAX_BANK_NAME_CHARS = 120
export const MAX_BRANCH_CHARS = 120
/** The IBAN standard's own ceiling: 34 characters, country code included. */
export const MAX_IBAN_CHARS = 34
export const MAX_ACCOUNT_NUMBER_CHARS = 34

/**
 * How long an IBAN is in the countries QuickIn's hosts actually bank in, plus the
 * major ones a host abroad might use. The length is part of the format, so a
 * transposed or truncated IBAN that still passes the checksum is caught here.
 * A country absent from this table is accepted on the checksum and the 15–34
 * bound alone — refusing an unlisted country would be worse than allowing it.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  EG: 29, SA: 24, AE: 23, KW: 30, QA: 29, BH: 22, OM: 23, JO: 30, LB: 28,
  MA: 28, TN: 24, DZ: 26, LY: 25, SD: 18, IQ: 23, PS: 29,
  GB: 22, IE: 22, FR: 27, DE: 22, IT: 27, ES: 24, PT: 25, NL: 18, BE: 16,
  CH: 21, AT: 20, SE: 24, NO: 15, DK: 18, FI: 18, PL: 28, GR: 27, TR: 26,
  RO: 24, CZ: 24, HU: 28, PK: 24,
}

/** Thrown for host input a human should fix; routes map it to HTTP 400. */
export class PayoutMethodError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayoutMethodError'
  }
}

/** Cross-realm-safe check (routes may see an error thrown in another bundle). */
export function isPayoutMethodError(e: unknown): e is PayoutMethodError {
  return e instanceof Error && e.name === 'PayoutMethodError'
}

/** What one `host_payout_methods` row holds, minus the bookkeeping columns. */
export interface PayoutMethodRecord {
  method: PayoutMethod
  /** Name the account is held in — the one the transfer has to match. */
  account_name: string
  /**
   * The canonical destination, derived at write time so every method has one
   * column to pay into: the IBAN (or the account number when there is no IBAN),
   * the InstaPay address, or the wallet number.
   */
  account_ref: string
  /** Bank only. */
  bank_name: string
  iban: string
  account_number: string
  /** Bank only, optional — needed for an international transfer. */
  swift_bic: string
  /** Bank only, optional. */
  branch: string
  /** Wallet provider for `wallet`; '' otherwise. */
  provider: string
}

/** A stored method as the profile screens render it. */
export interface PayoutMethodView extends PayoutMethodRecord {
  method_label: string
  provider_label: string
  /** The IBAN in the readable 4-character groups banks print it in; '' if none. */
  iban_formatted: string
  /** One line naming the destination. */
  display: string
  updated_at: string | null
}

/** Raw submission from a client. Every field is `unknown` — this is the boundary. */
export interface PayoutMethodInput {
  method?: unknown
  account_name?: unknown
  /** bank_account */
  bank_name?: unknown
  iban?: unknown
  account_number?: unknown
  swift_bic?: unknown
  branch?: unknown
  /** instapay */
  instapay_address?: unknown
  /** wallet */
  wallet_provider?: unknown
  wallet_number?: unknown
}

export function payoutMethodLabel(v: unknown): string {
  const s = String(v ?? '').trim()
  return PAYOUT_METHODS.find((m) => m.key === s)?.label ?? ''
}

export function walletProviderLabel(v: unknown): string {
  const s = String(v ?? '').trim()
  return WALLET_PROVIDERS.find((p) => p.key === s)?.label ?? ''
}

/**
 * Which of the three the host picked. THROWS rather than defaulting: guessing
 * would send their earnings somewhere they did not choose.
 */
export function normalizePayoutMethod(v: unknown): PayoutMethod {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!s) throw new PayoutMethodError('Please choose how you want to be paid')
  if (!PAYOUT_METHOD_KEYS.has(s)) {
    throw new PayoutMethodError(
      `Unknown payout method. Choose one of: ${PAYOUT_METHODS.map((m) => m.label).join(', ')}`
    )
  }
  return s as PayoutMethod
}

/** The account holder's name. Required for all three — a transfer needs a payee. */
export function normalizeAccountName(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ')
  if (!s) throw new PayoutMethodError('Enter the name on the account')
  if (s.length < 2) throw new PayoutMethodError('That name is too short')
  return s.slice(0, MAX_ACCOUNT_NAME_CHARS)
}

/** The bank the account is held at. Required for a bank payout — an account
 *  number without a bank is not something anyone can send money to. */
export function normalizeBankName(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ')
  if (!s) throw new PayoutMethodError('Enter the name of your bank')
  if (s.length < 2) throw new PayoutMethodError('That bank name is too short')
  return s.slice(0, MAX_BANK_NAME_CHARS)
}

/** Optional branch, for banks that route on it. */
export function normalizeBranch(v: unknown): string {
  return String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_BRANCH_CHARS)
}

/**
 * The ISO 7064 mod-97 checksum every IBAN satisfies — the IBAN's own guard
 * against a transposed or mistyped character.
 *
 * The arithmetic is done digit by digit rather than with BigInt, because an
 * expanded IBAN is up to 40+ digits and reducing as we go keeps it in Number
 * range on every runtime.
 */
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
 * An IBAN, stored compact and upper-cased so the same account typed with or
 * without spaces is one value. Empty is allowed — `validatePayout` is what
 * requires an IBAN *or* an account number, since a host who only knows their
 * account number must still be payable domestically.
 */
export function normalizeIban(v: unknown): string {
  const s = String(v ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (!s) return ''
  if (s.length < 15 || s.length > MAX_IBAN_CHARS) {
    throw new PayoutMethodError('That IBAN is not the right length')
  }
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) {
    throw new PayoutMethodError('An IBAN starts with two letters and two digits, like EG38…')
  }
  const expected = IBAN_LENGTHS[s.slice(0, 2)]
  if (expected && s.length !== expected) {
    throw new PayoutMethodError(`An IBAN for ${s.slice(0, 2)} is ${expected} characters — that one is ${s.length}`)
  }
  if (!ibanChecksumValid(s)) {
    throw new PayoutMethodError("That IBAN doesn't look right — please check it")
  }
  return s
}

/**
 * A plain bank account number. Kept as typed apart from separators: account
 * numbers have no checksum and no single national format, so validating beyond
 * "plausible characters, plausible length" would reject real accounts.
 */
export function normalizeAccountNumber(v: unknown): string {
  const s = String(v ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (!s) return ''
  if (!/^[A-Z0-9]+$/.test(s)) {
    throw new PayoutMethodError('An account number can only contain letters and digits')
  }
  if (s.length < 5 || s.length > MAX_ACCOUNT_NUMBER_CHARS) {
    throw new PayoutMethodError('That account number is not the right length')
  }
  return s
}

/**
 * A SWIFT/BIC code — 8 or 11 characters. Optional: it is only needed when the
 * money crosses a border, and most of QuickIn's hosts bank domestically.
 */
export function normalizeSwiftBic(v: unknown): string {
  const s = String(v ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (!s) return ''
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s)) {
    throw new PayoutMethodError('A SWIFT/BIC code is 8 or 11 characters, like NBEGEGCX')
  }
  return s
}

/** The IBAN in the 4-character groups banks print, for reading back. */
export function formatIban(v: unknown): string {
  const s = String(v ?? '').replace(/\s/g, '').toUpperCase()
  return s ? (s.match(/.{1,4}/g) ?? []).join(' ') : ''
}

/**
 * An InstaPay address, e.g. `kareem@instapay` or `kareem@banquemisr`. Lower-cased
 * because InstaPay addresses are case-insensitive and a stray capital would make
 * the same destination look like two different ones in /ops.
 */
export function normalizeInstapayAddress(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) throw new PayoutMethodError('Enter your InstaPay address')
  if (s.length > MAX_INSTAPAY_ADDRESS_CHARS) throw new PayoutMethodError('That InstaPay address is too long')
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(s)) {
    throw new PayoutMethodError('An InstaPay address looks like name@instapay')
  }
  return s
}

/**
 * A mobile-wallet number, normalised to the local Egyptian form `01XXXXXXXXX`
 * so the same phone typed as +20, 0020 or 01… is stored once. A number that is
 * plainly not Egyptian is kept in `+<digits>` form rather than rejected — a host
 * abroad still has to be payable.
 */
export function normalizeWalletNumber(v: unknown): string {
  const raw = String(v ?? '').trim()
  if (!raw) throw new PayoutMethodError('Enter your wallet number')
  const digits = raw.replace(/[\s()\-.]/g, '').replace(/^\+/, '').replace(/^00/, '')
  if (!/^\d+$/.test(digits)) throw new PayoutMethodError('A wallet number can only contain digits')
  const eg = digits.replace(/^20/, '')
  if (/^1\d{9}$/.test(eg)) return `0${eg}`
  if (/^01\d{9}$/.test(eg)) return eg
  if (digits.length < 8 || digits.length > 15) throw new PayoutMethodError('That wallet number is not the right length')
  return `+${digits}`
}

/** Which wallet the number belongs to. Defaults to 'other' rather than throwing. */
export function normalizeWalletProvider(v: unknown): WalletProvider {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!s) return 'other'
  return (WALLET_PROVIDER_KEYS.has(s) ? s : 'other') as WalletProvider
}

const EMPTY_BANK = { bank_name: '', iban: '', account_number: '', swift_bic: '', branch: '' }

/**
 * Validate a whole submission into the row we store.
 *
 * Every branch is validated before anything is written, so a half-valid bank
 * account never replaces a working InstaPay address. Fields belonging to the
 * other two methods are cleared rather than carried over — switching from a bank
 * to a wallet must not leave a stale IBAN on the row.
 */
export function validatePayout(input: PayoutMethodInput): PayoutMethodRecord {
  const method = normalizePayoutMethod(input.method)
  const account_name = normalizeAccountName(input.account_name)

  if (method === 'bank_account') {
    const bank_name = normalizeBankName(input.bank_name)
    const iban = normalizeIban(input.iban)
    const account_number = normalizeAccountNumber(input.account_number)
    // Either identifies the account: an IBAN covers every transfer, an account
    // number plus the bank covers a domestic one. Demanding both would block a
    // host who only knows one of them.
    if (!iban && !account_number) {
      throw new PayoutMethodError('Enter your IBAN or your account number')
    }
    return {
      method,
      account_name,
      account_ref: iban || account_number,
      bank_name,
      iban,
      account_number,
      swift_bic: normalizeSwiftBic(input.swift_bic),
      branch: normalizeBranch(input.branch),
      provider: '',
    }
  }

  if (method === 'instapay') {
    return {
      method,
      account_name,
      account_ref: normalizeInstapayAddress(input.instapay_address),
      ...EMPTY_BANK,
      provider: '',
    }
  }

  return {
    method,
    account_name,
    account_ref: normalizeWalletNumber(input.wallet_number),
    ...EMPTY_BANK,
    provider: normalizeWalletProvider(input.wallet_provider),
  }
}

/** The one line the profile shows back, naming the destination. */
export function payoutDisplay(record: PayoutMethodRecord): string {
  if (record.method === 'bank_account') {
    const ref = record.iban ? formatIban(record.iban) : record.account_number
    return record.bank_name ? `${record.bank_name} · ${ref}` : ref
  }
  if (record.method === 'wallet') {
    const provider = walletProviderLabel(record.provider)
    return provider && record.provider !== 'other'
      ? `${provider} · ${record.account_ref}`
      : record.account_ref
  }
  return record.account_ref
}

/** Build the profile view from a raw `host_payout_methods` row (null ⇒ none set). */
export function rowToPayoutMethod(
  row: {
    method?: unknown
    account_name?: unknown
    account_ref?: unknown
    bank_name?: unknown
    iban?: unknown
    account_number?: unknown
    swift_bic?: unknown
    branch?: unknown
    provider?: unknown
    updated_at?: unknown
  } | null | undefined
): PayoutMethodView | null {
  if (!row) return null
  const method = String(row.method ?? '').trim()
  if (!PAYOUT_METHOD_KEYS.has(method)) return null
  const record: PayoutMethodRecord = {
    method: method as PayoutMethod,
    account_name: String(row.account_name ?? ''),
    account_ref: String(row.account_ref ?? ''),
    bank_name: String(row.bank_name ?? ''),
    iban: String(row.iban ?? ''),
    account_number: String(row.account_number ?? ''),
    swift_bic: String(row.swift_bic ?? ''),
    branch: String(row.branch ?? ''),
    provider: String(row.provider ?? ''),
  }
  return {
    ...record,
    method_label: payoutMethodLabel(record.method),
    provider_label: record.method === 'wallet' ? walletProviderLabel(record.provider) : '',
    iban_formatted: formatIban(record.iban),
    display: payoutDisplay(record),
    updated_at: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
  }
}

/** True once the host has somewhere to be paid — the profile-completeness flag. */
export function isPayoutReady(view: PayoutMethodView | null | undefined): boolean {
  return Boolean(view && view.account_ref)
}
