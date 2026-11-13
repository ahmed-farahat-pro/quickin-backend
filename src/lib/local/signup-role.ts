// Reads and applies the role half of a signup (or of the Google "Complete your
// account" step): the Guest/Host choice, a host's hosting page and payout
// destination, and a guest's optional refund destination. The rules live in
// signup-role-core and payout-method-core; this runs them field by field so both
// routes answer with one per-field `fields` map alongside signup-identity's.
import { submitHostApplication, savePayoutMethod } from './db'
import { isPayoutMethodError, validatePayout, type PayoutMethodRecord } from './payout-method-core'
import {
  hasMoneyDestination,
  normalizeSignupRole,
  readHostingDetails,
  type HostingDetails,
  type SignupRole,
} from './signup-role-core'
import { HOST_TERMS_VERSION, hostTermsAccepted } from './host-application-core'
import type { SignupIdentity } from './signup-identity'

export interface SignupRoleParts {
  role: SignupRole
  /** Host only. */
  hosting: HostingDetails | null
  /** The host's payout destination (required) or the guest's refund one (optional). */
  destination: PayoutMethodRecord | null
}

function readDestination(v: unknown, key: string, fields: Record<string, string>): PayoutMethodRecord | null {
  try {
    return validatePayout(v as Record<string, unknown>)
  } catch (e) {
    fields[key] = isPayoutMethodError(e) ? (e as Error).message : 'Please check these details'
    return null
  }
}

/**
 * `{ parts }` when every role field is good, else `{ fields }`. Keys:
 * `host_type` / `address` / `company` / `notes` / `terms` for the hosting page,
 * `payout` for a host's destination (the same key /host/apply reads),
 * `refund_method` for a guest's.
 */
export function readSignupRole(
  b: Record<string, unknown>
): { parts: SignupRoleParts; fields?: undefined } | { parts?: undefined; fields: Record<string, string> } {
  const role = normalizeSignupRole(b.role)
  const fields: Record<string, string> = {}

  if (role === 'guest') {
    // Optional: a skipped step sends nothing (or an empty object).
    const destination = hasMoneyDestination(b.refund_method)
      ? readDestination(b.refund_method, 'refund_method', fields)
      : null
    if (Object.keys(fields).length) return { fields }
    return { parts: { role, hosting: null, destination } }
  }

  const read = readHostingDetails(b)
  if (read.fields) Object.assign(fields, read.fields)
  // The application this files must accept the host terms, as on /host/apply.
  if (!hostTermsAccepted(b.terms_accepted ?? b.termsAccepted)) fields.terms = 'Accept the host terms to apply'
  let destination: PayoutMethodRecord | null = null
  if (!hasMoneyDestination(b.payout)) {
    fields.payout = 'Add a bank account or InstaPay to receive your earnings'
  } else {
    destination = readDestination(b.payout, 'payout', fields)
  }
  if (Object.keys(fields).length || !read.hosting) return { fields }
  return { parts: { role, hosting: read.hosting, destination } }
}

/**
 * Write the role half for an account whose identity document is already filed.
 * A host's application is the same one /host/apply files — it links the
 * signup's pending ID instead of filing a second one — so it reaches /ops now.
 */
export async function applySignupRole(
  userId: string,
  parts: SignupRoleParts,
  identity: SignupIdentity,
  fullName: string
): Promise<void> {
  if (parts.destination) await savePayoutMethod(userId, parts.destination)
  if (parts.role === 'host' && parts.hosting) {
    await submitHostApplication(userId, {
      full_name: fullName,
      national_id: identity.idNumber,
      phone: identity.phone,
      address: parts.hosting.address,
      host_type: parts.hosting.host_type,
      company: parts.hosting.company,
      notes: parts.hosting.notes,
      terms_version: HOST_TERMS_VERSION,
    })
  }
}
