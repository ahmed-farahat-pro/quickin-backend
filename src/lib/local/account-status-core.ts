// Account status (block / remove) as this API sees it — D3/D4.
//
// Pure, and DELIBERATELY free of runtime imports — Node's ESM resolver rejects the
// extension-less relative specifiers the rest of src/lib/local uses, so a module
// with no relative imports is the one shape `node --test` can load directly.
// auth.ts imports this; never the reverse. See README → Testing.
//
// SCOPE: this is a deliberately SMALLER sibling of the web app's
// quickin-frontend/src/lib/local/user-admin-core.ts. Only /ops (the web project)
// *writes* account status; this project only *reads* it, so all that belongs here is
// the predicate, the rejection copy, and the mobile response contract.
//
// The two files are NOT byte-identical and are NOT parity-guarded — unlike
// resort-core.ts / payment-config-core.ts, which ARE guarded because both projects
// write the same rows through them. Please don't "fix" that with a check-*-parity
// script: it would make every future edit here a mandatory two-repo commit for no
// correctness gain. What actually matters is the mobile contract below, and that is
// locked by test/unit/account-status-core.test.mjs.

export const ACCOUNT_STATUSES = ['active', 'blocked', 'removed'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

/** SQL fragment for "this account may sign in". Tolerant of a pre-migration row
 *  where the column doesn't exist yet — see the note on normalizeStatus. */
export const ACTIVE_ACCOUNT_SQL = `COALESCE(account_status, 'active') = 'active'`

/** Anything unrecognised reads as 'active'. A NULL or unknown value must never lock
 *  someone out: the column is NOT NULL DEFAULT 'active', but a row written before
 *  the migration — or carrying a status a future build introduced — should still be
 *  able to sign in rather than be silently banned. */
export function normalizeStatus(value: unknown): AccountStatus {
  const v = String(value ?? '').trim().toLowerCase()
  return (ACCOUNT_STATUSES as readonly string[]).includes(v) ? (v as AccountStatus) : 'active'
}

export function isActiveStatus(value: unknown): boolean {
  return normalizeStatus(value) === 'active'
}

/** What a blocked/removed person is told when they try to sign in. Only ever
 *  returned AFTER the password checks out, so it leaks nothing to a stranger. */
export function blockedLoginMessage(status: unknown): string {
  if (normalizeStatus(status) === 'removed') {
    return 'This account has been closed. Contact support@quickin.app if you think this is a mistake.'
  }
  return 'Your account has been suspended. Contact support@quickin.app if you think this is a mistake.'
}

/**
 * The body a token-minting route returns for a blocked/removed account, at HTTP 403.
 *
 * **The mobile contract, and why the shape matters.** iOS and Android both branch on
 * `403 AND needsVerification == true` → OTP screen (`AuthService.kt` `needsVerification(text)`,
 * `AuthService.swift` `body.needsVerification == true`); anything else at 403 falls
 * through to displaying `error` verbatim. So this body renders our message on both
 * apps with no app update — but it must NEVER carry `needsVerification`, or a blocked
 * user is routed to the OTP screen and verifies successfully into an account that
 * still refuses them.
 */
export function blockedLoginBody(status: unknown): { error: string; accountStatus: AccountStatus } {
  const s = normalizeStatus(status)
  return { error: blockedLoginMessage(s), accountStatus: s }
}

/** Blocked/removed accounts are rejected with 403 — see blockedLoginBody. */
export const BLOCKED_STATUS_CODE = 403
