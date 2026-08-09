import { pool } from './pool'
import {
  inspectContent,
  combinesIntoContact,
  ContactBlockedError,
  type GuardKind,
  type GuardSurface,
} from './contentguard'
import { normalizeKind, normalizeSurface, truncateBody } from './moderation-core'

// Policy violations: recording a blocked attempt, and the warning gate.
//
// The content guard (contentguard.ts) refuses to store a message carrying contact
// details. This module is what REMEMBERS that it happened, so /ops → Moderation
// can see who keeps trying — and holds the gate that stops a warned user chatting
// until they have acknowledged the warning.
//
// It lives apart from db.ts because `reviews.ts` and `auth.ts` guard their own
// writes too, and importing db.ts from either would be a cycle. Its only imports
// are the pool, the guard, and the pure core.
//
// Everything on the WRITE side is best-effort: if recording fails — the migration
// hasn't run yet, the table is briefly unavailable — the user is still refused. A
// logging fault must never become a way past the guard.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

/** One recorded attempt to publish contact details. */
export interface PolicyViolationInput {
  userId: string
  kind: GuardKind
  surface: GuardSurface
  body: string
  /** True when only the cross-message check caught it — a deliberate drip-feed. */
  split?: boolean
  context?: { type: string; id: string } | null
}

/** Insert one violation row. Never throws — see the note above. */
export async function recordPolicyViolation(entry: PolicyViolationInput): Promise<void> {
  try {
    if (!isUuid(entry.userId)) return
    await pool.query(
      `INSERT INTO policy_violations (user_id, kind, surface, body, split, context_type, context_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.userId,
        normalizeKind(entry.kind),
        normalizeSurface(entry.surface),
        truncateBody(entry.body),
        entry.split === true,
        entry.context?.type ?? null,
        entry.context?.id ?? null,
      ],
    )
  } catch (err) {
    // Deliberately swallowed. The caller is about to refuse the write either way.
    console.error('recordPolicyViolation failed (the block still stands):', err)
  }
}

/**
 * Run the content guard, RECORD a blocked attempt, then refuse it.
 *
 * Replaces a bare `assertNoContactInfo` on every write path, so no surface can
 * block something without leaving a trace for /ops → Moderation.
 */
export async function guardContent(
  userId: string,
  text: string,
  surface: GuardSurface,
  context?: { type: string; id: string } | null,
): Promise<void> {
  const verdict = inspectContent(text, surface)
  if (!verdict.blocked) return
  await recordPolicyViolation({ userId, kind: verdict.kind!, surface, body: text, context })
  throw new ContactBlockedError(verdict.message!, verdict.kind!)
}

/**
 * The cross-message half: contact details completed across the sender's recent
 * messages. Recorded with `split` set, because drip-feeding a number over four
 * messages reads very differently from one careless paste, and the moderation
 * screen shows the difference.
 */
export async function guardSplitContent(
  userId: string,
  previousBodies: string[],
  newBody: string,
  surface: GuardSurface,
  context?: { type: string; id: string } | null,
): Promise<void> {
  const verdict = combinesIntoContact(previousBodies, newBody, surface)
  if (!verdict.blocked) return
  await recordPolicyViolation({ userId, kind: verdict.kind!, surface, body: newBody, split: true, context })
  throw new ContactBlockedError(verdict.message!, verdict.kind!)
}

// ---- The warning gate -------------------------------------------------------

/** A warning the user has been issued but not yet acknowledged. */
export interface PendingWarning {
  id: string
  message: string
}

/**
 * The gate, read on every chat send — hence a single lookup against a partial
 * index covering unacknowledged rows only.
 *
 * Enforced server-side precisely so an app build that predates the acknowledge
 * dialog cannot ignore it. Such a client still can't send, and still shows the
 * warning, because the text travels in `error` as well as in `policyWarning`.
 */
export async function pendingWarningFor(userId: string): Promise<PendingWarning | null> {
  if (!isUuid(userId)) return null
  try {
    const { rows } = await pool.query(
      `SELECT id, message FROM policy_warnings
        WHERE user_id = $1 AND acknowledged_at IS NULL
        ORDER BY issued_at DESC LIMIT 1`,
      [userId],
    )
    return (rows[0] as PendingWarning | undefined) ?? null
  } catch (err) {
    // Code ahead of the migration: chat must keep working. The gate is an added
    // restriction, not a prerequisite for sending a message.
    console.error('pendingWarningFor failed (treating as no warning):', err)
    return null
  }
}

/**
 * The user has read the warning. Scoped to their own row, so an id lifted from
 * anywhere else clears nothing. False when there was nothing pending.
 */
export async function acknowledgeWarning(userId: string, warningId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(warningId)) return false
  const { rowCount } = await pool.query(
    `UPDATE policy_warnings SET acknowledged_at = now()
      WHERE id = $1 AND user_id = $2 AND acknowledged_at IS NULL`,
    [warningId, userId],
  )
  return (rowCount ?? 0) > 0
}
