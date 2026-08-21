// How an email address that owns MORE THAN ONE users row is resolved at sign-in.
//
// `scripts/migrate-split-accounts.mjs` dropped the unique constraint on users.email and
// keyed uniqueness on `(lower(email), role)` instead, to allow a separate guest and host
// account per address. That model was later abandoned in favour of one unified account
// (see the signup route), but the index — and the duplicate rows already created under
// it — are still there, so "the user with this email" remains genuinely ambiguous.
//
// The bug this module exists to prevent: both projects resolved the ambiguity by picking
// ONE row and THEN checking the password against only that row, and they picked
// differently — quickin-backend with `ORDER BY (role = 'user') DESC LIMIT 1`, the web
// with an unordered `rows[0]`. For an address whose password lived on the row the
// backend did not pick, the very same credentials signed in on the web and came back
// "Invalid email or password" on iOS/Android. Let the CREDENTIALS choose the row and
// both clients agree no matter how the duplicates happen to be laid out.
//
// Deliberately dependency-free (no relative imports) so `node --test` can load it —
// see README → Testing. Callers inject the password check and the status check.

/** Pick the row a sign-in attempt authenticates as.
 *
 *  `rows` must be ordered most-canonical-first by the caller, so that when several rows
 *  share the same password the winner is stable rather than heap order.
 *
 *  Returns the first row the password verifies against, else the canonical row so the
 *  caller's existing wrong-password branch still runs and still answers 401 — this must
 *  never turn "wrong password" into "no such user", which would leak which addresses
 *  are registered. */
export function pickLoginRow<T>(rows: readonly T[], passwordMatches: (row: T) => boolean): T | null {
  if (rows.length === 0) return null
  for (const row of rows) if (passwordMatches(row)) return row
  return rows[0]
}

/** The row that should refuse the whole address, if any.
 *
 *  /ops blocks or removes ONE row by id. With duplicates present, checking only the row
 *  that happened to authenticate would let a suspended person sign in through a sibling
 *  row that was never blocked, so a block is enforced across every row for the address. */
export function blockedRowAmong<T>(rows: readonly T[], isActive: (row: T) => boolean): T | null {
  for (const row of rows) if (!isActive(row)) return row
  return null
}

/** Ordering used for the `rows` passed above, kept next to the logic that relies on it.
 *  `role = 'user'` first preserves the row this API has always preferred, then oldest
 *  first, then id so the result is total and never depends on physical row order. */
export const LOGIN_ROW_ORDER_SQL = `ORDER BY (role = 'user') DESC, created_at NULLS LAST, id`
