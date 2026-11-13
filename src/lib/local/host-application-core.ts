// The become-a-host application on the SAME account (2026-11-13).
//
// A guest already gave their name, phone and ID at signup, so the application
// never asks for them again: the server reads them from the profile and the
// clients show them read-only ("From your profile"). Only what the profile is
// MISSING — an account from before the signup rule — is asked for in the form.
// The application itself adds the host-only facts: host type, address, a payout
// destination and acceptance of the host terms.
//
// Pure, no relative imports, so `node --test` can load it directly. The caller
// passes values that have already been through the name policy / phone core —
// this file only decides which source wins.

/** The profile fields an application needs, in the order the forms show them. */
export const PROFILE_FIELDS = ['full_name', 'phone', 'national_id'] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]

/** Bumped when the host terms change materially; stored with the acceptance. */
export const HOST_TERMS_VERSION = '2026-11-13'

export interface ApplicantProfileInput {
  /** users.full_name, ALREADY known to pass the name policy — else null. */
  fullName?: string | null
  /** users.phone in canonical form (phone-core) — else null. */
  phone?: string | null
  /** Status of the latest id_verifications row. */
  verificationStatus?: unknown
  /** The number on that row, when it carried one. */
  idNumber?: string | null
}

export interface ApplicantProfile {
  /** Values taken from the profile; null where the profile has none to give. */
  onFile: Record<ProfileField, string | null>
  /** Fields the form must ask for because the profile cannot supply them. */
  missing: ProfileField[]
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * What the profile can supply. The ID number counts only while the submission
 * behind it stands — verified, or pending review. A rejected document's number
 * is not one to file a host application under: the applicant re-uploads, and
 * declares the number with the new photos.
 */
export function applicantProfile(p: ApplicantProfileInput): ApplicantProfile {
  const status = text(p.verificationStatus).toLowerCase()
  const idStands = status === 'verified' || status === 'pending'
  const onFile: Record<ProfileField, string | null> = {
    full_name: text(p.fullName) || null,
    phone: text(p.phone) || null,
    national_id: idStands ? text(p.idNumber) || null : null,
  }
  return { onFile, missing: PROFILE_FIELDS.filter((f) => !onFile[f]) }
}

/**
 * The value to file for one profile field. The profile WINS whenever it has
 * one: the form shows it read-only, and an application that contradicts the
 * profile would put the reviewer between two different answers. A submitted
 * value is used only to fill a gap.
 */
export function resolveProfileField(profile: ApplicantProfile, field: ProfileField, submitted: unknown): string {
  return profile.onFile[field] ?? text(submitted)
}

/** True only for an explicit acceptance — a missing or falsy flag is a refusal. */
export function hostTermsAccepted(v: unknown): boolean {
  return v === true || v === 'true'
}

/**
 * Whether the application must carry a payout destination. A host who already
 * keeps one (a re-applicant after a rejection) is not made to type it again;
 * they may still send one to replace it.
 */
export function payoutRequired(hasPayoutOnFile: boolean): boolean {
  return !hasPayoutOnFile
}

/** True when the body carries a payout object worth validating. */
export function payoutSubmitted(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0
}
