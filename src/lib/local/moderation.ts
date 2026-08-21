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


// ---- /ops additions, ported from quickin-frontend 21 Aug 2026 ----

/** One row in the Moderation queue: a user and everything they've been caught at. */
export interface FlaggedUserRow {
  user_id: string
  full_name: string | null
  email: string
  role: string | null
  account_status: string
  /** Every recorded attempt, reviewed or not. */
  total: number
  /** The ones no moderator has looked at — what the alert counts. */
  unreviewed: number
  kind_phone: number
  kind_email: number
  kind_social: number
  kind_url: number
  /** How many were caught only by stitching messages together — intent, not accident. */
  split_count: number
  last_at: string
  last_kind: string
  last_surface: string
  /** The most recent attempt verbatim, so the queue is readable without drilling in. */
  last_body: string
  warnings: number
  /** True while a warning is issued and unacknowledged — chat is gated right now. */
  pending_warning: boolean
}

/** One recorded attempt, as the history view shows it. */
export interface ViolationRow {
  id: string
  kind: string
  surface: string
  body: string
  split: boolean
  context_type: string | null
  context_id: string | null
  created_at: string
  reviewed_at: string | null
  reviewed_by: string | null
}

/** Warnings issued to a user and whether they were read. */
export interface WarningRow {
  id: string
  message: string
  issued_by: string
  issued_at: string
  acknowledged_at: string | null
}

/**
 * Issue a warning and close the outstanding attempts in one transaction — a
 * warning that didn't clear the queue would be re-issued by the next moderator
 * to open the screen.
 *
 * Only ONE warning can be pending at a time: issuing a second while the first is
 * unacknowledged would leave the user acknowledging one and still gated by the
 * other, with no way to see it.
 */
export async function adminIssueWarning(
  userId: string,
  message: string,
  actor: string,
): Promise<{ id: string; alreadyPending: boolean; reviewed: number }> {
  if (!isUuid(userId)) throw new Error('Invalid user')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      `SELECT id FROM policy_warnings WHERE user_id = $1 AND acknowledged_at IS NULL LIMIT 1`,
      [userId],
    )
    if (existing.rows[0]) {
      const reviewed = await client.query(
        `UPDATE policy_violations SET reviewed_at = now(), reviewed_by = $2
          WHERE user_id = $1 AND reviewed_at IS NULL`,
        [userId, actor],
      )
      await client.query('COMMIT')
      return { id: existing.rows[0].id as string, alreadyPending: true, reviewed: reviewed.rowCount ?? 0 }
    }
    const ins = await client.query(
      `INSERT INTO policy_warnings (user_id, message, issued_by) VALUES ($1, $2, $3) RETURNING id`,
      [userId, message, actor],
    )
    const reviewed = await client.query(
      `UPDATE policy_violations SET reviewed_at = now(), reviewed_by = $2
        WHERE user_id = $1 AND reviewed_at IS NULL`,
      [userId, actor],
    )
    await client.query('COMMIT')
    return { id: ins.rows[0].id as string, alreadyPending: false, reviewed: reviewed.rowCount ?? 0 }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * The queue. `scope: 'open'` (the default) is users with at least one unreviewed
 * attempt — the working list. `'all'` keeps history visible after it's actioned,
 * which is what makes a repeat offender recognisable months later.
 */
export async function adminListFlaggedUsers(scope: 'open' | 'all' = 'open'): Promise<FlaggedUserRow[]> {
  const onlyOpen = scope !== 'all'
  const { rows } = await pool.query(
    `SELECT v.user_id,
            u.full_name, u.email, u.role,
            COALESCE(u.account_status, 'active') AS account_status,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE v.reviewed_at IS NULL)::int AS unreviewed,
            COUNT(*) FILTER (WHERE v.kind = 'phone')::int  AS kind_phone,
            COUNT(*) FILTER (WHERE v.kind = 'email')::int  AS kind_email,
            COUNT(*) FILTER (WHERE v.kind = 'social')::int AS kind_social,
            COUNT(*) FILTER (WHERE v.kind = 'url')::int    AS kind_url,
            COUNT(*) FILTER (WHERE v.split)::int AS split_count,
            to_char((MAX(v.created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at,
            (SELECT v2.kind    FROM policy_violations v2 WHERE v2.user_id = v.user_id ORDER BY v2.created_at DESC LIMIT 1) AS last_kind,
            (SELECT v2.surface FROM policy_violations v2 WHERE v2.user_id = v.user_id ORDER BY v2.created_at DESC LIMIT 1) AS last_surface,
            (SELECT v2.body    FROM policy_violations v2 WHERE v2.user_id = v.user_id ORDER BY v2.created_at DESC LIMIT 1) AS last_body,
            (SELECT COUNT(*) FROM policy_warnings w WHERE w.user_id = v.user_id)::int AS warnings,
            EXISTS (SELECT 1 FROM policy_warnings w
                     WHERE w.user_id = v.user_id AND w.acknowledged_at IS NULL) AS pending_warning
       FROM policy_violations v
       JOIN users u ON u.id = v.user_id
      GROUP BY v.user_id, u.full_name, u.email, u.role, u.account_status
      ${onlyOpen ? 'HAVING COUNT(*) FILTER (WHERE v.reviewed_at IS NULL) > 0' : ''}
      ORDER BY MAX(v.created_at) DESC
      LIMIT 200`,
  )
  return rows as FlaggedUserRow[]
}

/**
 * Mark a user's outstanding attempts as looked at. Every moderator action calls
 * this — it is what drains the alert. Returns how many rows it closed.
 */
export async function adminMarkViolationsReviewed(userId: string, actor: string): Promise<number> {
  if (!isUuid(userId)) return 0
  const { rowCount } = await pool.query(
    `UPDATE policy_violations SET reviewed_at = now(), reviewed_by = $2
      WHERE user_id = $1 AND reviewed_at IS NULL`,
    [userId, actor],
  )
  return rowCount ?? 0
}

/** A single user's full history, newest first — reviewed rows included, because
 *  "they were warned about this in June" is the whole point of keeping them. */
export async function adminUserViolations(userId: string): Promise<ViolationRow[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT id, kind, surface, body, split, context_type, context_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
            reviewed_by
       FROM policy_violations
      WHERE user_id = $1
      ORDER BY policy_violations.created_at DESC
      LIMIT 200`,
    [userId],
  )
  return rows as ViolationRow[]
}

export async function adminUserWarnings(userId: string): Promise<WarningRow[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT id, message, issued_by,
            to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS issued_at,
            to_char(acknowledged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS acknowledged_at
       FROM policy_warnings WHERE user_id = $1 ORDER BY policy_warnings.issued_at DESC LIMIT 50`,
    [userId],
  )
  return rows as WarningRow[]
}

/** How many users have unreviewed attempts — the Alerts count. Zero when the
 *  table doesn't exist yet, so an un-migrated database shows a calm console
 *  rather than a broken dashboard. */
export async function countFlaggedUsers(): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS n FROM policy_violations WHERE reviewed_at IS NULL`,
    )
    return Number(rows[0]?.n ?? 0)
  } catch {
    return 0
  }
}

/** When the oldest unreviewed attempt arrived, so the alert can say "3 days". */
export async function oldestFlaggedAt(): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      `SELECT to_char((MIN(created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t
         FROM policy_violations WHERE reviewed_at IS NULL`,
    )
    return (rows[0]?.t as string | null) ?? null
  } catch {
    return null
  }
}
