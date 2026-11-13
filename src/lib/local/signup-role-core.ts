// Signup role — from 2026-11-13 a first-time signup picks Guest or Host and walks
// through stepped pages that collect everything up front, so nothing is asked
// again when the user books a unit or later applies to host.
//
//   guest: account → identity → refund (optional, skippable)
//   host:  account → identity → hosting → payout (required)
//
// The identity step is signup-identity-core's (phone + ID document). The host's
// hosting step files the SAME host application as POST /api/local/host/apply, so
// it lands in the /ops queue straight away; the host's payout step is the same
// destination the profile edits (payout-method-core). A guest's refund
// destination is stored in that same one-row-per-user table — it is simply where
// QuickIn sends this person money — so a guest who later becomes a host already
// has payout details on file.
//
// A client that sends no `role` (every build from before this change) is a guest
// with no refund step, which is exactly the old behaviour.
//
// No runtime imports, so `node --test` can import this file directly — see
// README → Testing. Payout validation itself lives in payout-method-core and is
// run by signup-role.ts.

export const SIGNUP_ROLES = ['guest', 'host'] as const
export type SignupRole = (typeof SIGNUP_ROLES)[number]

/** The pages each role walks through, in order — what the step indicator counts. */
export const SIGNUP_STEPS: Readonly<Record<SignupRole, readonly string[]>> = {
  guest: ['account', 'identity', 'refund'],
  host: ['account', 'identity', 'hosting', 'payout'],
}

/** Must match HOST_TYPES in db.ts (asserted by the unit test). */
export const SIGNUP_HOST_TYPES = ['individual', 'company', 'brokerage'] as const
export type SignupHostType = (typeof SIGNUP_HOST_TYPES)[number]

export const MAX_ADDRESS_CHARS = 300
export const MAX_COMPANY_CHARS = 120
export const MAX_NOTES_CHARS = 1000

/** Anything but a literal 'host' is a guest — a missing role is an old client. */
export function normalizeSignupRole(v: unknown): SignupRole {
  return typeof v === 'string' && v.trim().toLowerCase() === 'host' ? 'host' : 'guest'
}

/**
 * True when the body carries a money destination the user actually filled in.
 * An absent key, `null`, an empty object or one with no `method` all mean
 * "skipped" — the guest's refund step is optional and the clients may send any
 * of those for it.
 */
export function hasMoneyDestination(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const method = (v as Record<string, unknown>).method
  return typeof method === 'string' && method.trim() !== ''
}

export interface HostingDetails {
  host_type: SignupHostType
  address: string
  /** Null for an individual — the same rule submitHostApplication applies. */
  company: string | null
  notes: string | null
}

const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/**
 * The host-only page: host type, address, company (company/brokerage only) and
 * notes. `{ hosting }` when valid, else `{ fields }` keyed like the request body
 * and the host application (`host_type`, `address`, `company`, `notes`).
 */
export function readHostingDetails(
  b: Record<string, unknown>
): { hosting: HostingDetails; fields?: undefined } | { hosting?: undefined; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  const hostType = str(b.host_type ?? b.hostType).toLowerCase()
  const address = str(b.address)
  const company = str(b.company)
  // Notes keep their line breaks — only trimmed.
  const notes = typeof b.notes === 'string' ? b.notes.trim() : ''

  if (!(SIGNUP_HOST_TYPES as readonly string[]).includes(hostType)) {
    fields.host_type = 'Choose individual, company or brokerage'
  }
  if (!address) fields.address = 'Address is required'
  else if (address.length > MAX_ADDRESS_CHARS) fields.address = `Keep the address under ${MAX_ADDRESS_CHARS} characters`
  // Company stays optional, as on /host/apply — signup must not be stricter
  // than the application it files.
  if (company.length > MAX_COMPANY_CHARS) {
    fields.company = `Keep the company name under ${MAX_COMPANY_CHARS} characters`
  }
  if (notes.length > MAX_NOTES_CHARS) fields.notes = `Keep the notes under ${MAX_NOTES_CHARS} characters`

  if (Object.keys(fields).length) return { fields }
  const host_type = hostType as SignupHostType
  return {
    hosting: {
      host_type,
      address,
      company: host_type === 'individual' ? null : company || null,
      notes: notes || null,
    },
  }
}
