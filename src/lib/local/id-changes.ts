import { pool } from './pool'
import {
  IdChangeError,
  IdChangeUnavailableError,
  isMissingRelationError,
  assertActuallyChanges,
  assertReviewable,
  canonicalDocumentNumber,
  normalizeDocumentImage,
  normalizeDocumentNumber,
  normalizeIdChangeReason,
  normalizeIdChangeStatus,
  type IdChangeStatus,
  normalizeIdChangeAction,
  normalizeIdChangeNote,
  assertRejectionExplained,
  statusForIdChangeAction,
  type IdChangeAction,
} from './id-change-core'

// The submitting half of the ID change queue — what a signed-in user can do to the
// identity number on their profile now that they cannot type over it.
//
// The deciding half (list, approve, reject) lives in the FRONTEND repo's db.ts,
// because /ops is deployed there. Both write the same `id_change_requests` rows on
// the shared Neon DB, and both validate through the byte-identical id-change-core.
// See scripts/migrate-id-change-requests.mjs for why this is not folded into
// id_verifications.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

/**
 * Run a statement against `id_change_requests`, turning "that table is not on this
 * database" into the error the routes answer 503 to.
 *
 * The write paths need this because the table ships with a migration that is applied
 * by hand: code can reach production a deploy or several before the SQL does, and in
 * that window a submit failed as an unexplained 500 reading "Could not submit your
 * request" — which sends the user back to correct a number that was never the problem.
 * Only the missing-relation codes are translated; a real fault still raises a 500,
 * because pretending a broken query is a maintenance window is how a fault goes
 * unnoticed for weeks.
 */
async function queueQuery(text: string, params: unknown[] = []) {
  try {
    return await pool.query(text, params)
  } catch (err) {
    if (!isMissingRelationError(err)) throw err
    console.error(
      'id_change_requests is not on this database — run scripts/migrate-id-change-requests.mjs against it:',
      (err as Error).message
    )
    throw new IdChangeUnavailableError()
  }
}

export interface IdChangeRequest {
  id: string
  status: IdChangeStatus
  requested_value: string
  current_value: string | null
  doc_type: string
  reason: string | null
  /** The operator's note. On a rejection this is the reason to show the user. */
  notes: string | null
  submitted_at: string | null
  reviewed_at: string | null
}

/** What the profile screen needs to render the read-only ID row and its status. */
export interface IdChangeState {
  /** The value on the profile right now — the only one that counts. */
  current: string | null
  /** The user's most recent request, whatever became of it, or null if they never filed one. */
  request: IdChangeRequest | null
  /** False only while a request is pending; the clients hide the action on false. */
  can_request: boolean
  /**
   * False when the queue's table is not on this database yet, so `request` is not
   * "you have never filed one" but "we could not look". Reported rather than inferred:
   * without it the profile screen cannot tell a clean slate from a blind spot, and a
   * pending request would silently render as none.
   */
  available: boolean
}

// Images are excluded from every read below. A user re-opening their profile does not
// need the megabyte of base64 they uploaded sent back to them, and the /ops reviewer
// fetches them through its own query.
const REQUEST_COLUMNS = `
  id, status, requested_value, current_value, doc_type, reason, notes,
  to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
  to_char(reviewed_at AT TIME ZONE 'UTC',  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at`

function rowToRequest(row: Record<string, unknown> | undefined): IdChangeRequest | null {
  if (!row) return null
  return {
    id: String(row.id),
    status: normalizeIdChangeStatus(row.status),
    requested_value: String(row.requested_value ?? ''),
    current_value: (row.current_value as string) ?? null,
    doc_type: String(row.doc_type ?? 'national_id'),
    reason: (row.reason as string) ?? null,
    notes: (row.notes as string) ?? null,
    submitted_at: (row.submitted_at as string) ?? null,
    reviewed_at: (row.reviewed_at as string) ?? null,
  }
}

/**
 * The user's current ID number plus the state of their latest change request.
 *
 * The request half DEGRADES when the table is missing, the same contract the /ops
 * counts have always had. This read backs the ID row on Edit Profile, and a 500 here
 * took the row's own value down with it for a request the user may not even have —
 * the number on file lives on `users` and is knowable either way.
 */
export async function getIdChangeState(userId: string): Promise<IdChangeState> {
  if (!isUuid(userId)) throw new IdChangeError('Invalid user')
  const [profile, request] = await Promise.all([
    pool.query(`SELECT id_document FROM users WHERE id = $1`, [userId]),
    pool
      .query(
        `SELECT ${REQUEST_COLUMNS} FROM id_change_requests
          WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
        [userId],
      )
      // Only the un-migrated case. Anything else is a fault and must still surface.
      .catch((err) => {
        if (!isMissingRelationError(err)) throw err
        return null
      }),
  ])
  const latest = rowToRequest(request?.rows[0])
  return {
    current: (profile.rows[0]?.id_document as string) ?? null,
    request: latest,
    can_request: latest?.status !== 'pending',
    available: request !== null,
  }
}

/**
 * File a request to change the identity number on the profile.
 *
 * Resubmitting REPLACES a pending request rather than queueing a second one — the
 * partial-unique index enforces one open request per user, and someone correcting a
 * typo in what they just submitted should not cost the reviewer two decisions. A
 * request that has already been decided is left alone as the record of that decision.
 */
export async function submitIdChangeRequest(args: {
  userId: string
  requestedValue: unknown
  docType: string
  front: unknown
  back?: unknown
  reason?: unknown
}): Promise<IdChangeState> {
  const { userId, docType } = args
  if (!isUuid(userId)) throw new IdChangeError('Invalid user')

  const requested = normalizeDocumentNumber(args.requestedValue, docType)
  const front = normalizeDocumentImage(args.front, 'The front of your document')
  assertReviewable(front)
  const back = normalizeDocumentImage(args.back, 'The back of your document')
  const reason = normalizeIdChangeReason(args.reason)

  // Snapshot what is on the profile now, so the reviewer sees the real before/after
  // even if something else changes the column before they get to it.
  const profile = await pool.query(`SELECT id_document FROM users WHERE id = $1`, [userId])
  if (!profile.rows[0]) throw new IdChangeError('Profile not found')
  const current = (profile.rows[0].id_document as string) ?? null
  assertActuallyChanges(current, requested)

  const pending = await queueQuery(
    `SELECT id FROM id_change_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
    [userId],
  )
  if (pending.rows[0]) {
    await queueQuery(
      `UPDATE id_change_requests
          SET requested_value = $2, current_value = $3, doc_type = $4,
              image_data = $5, back_image_data = $6, reason = $7,
              status = 'pending', notes = NULL,
              submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL
        WHERE id = $1`,
      [pending.rows[0].id, requested, current, docType, front, back, reason],
    )
  } else {
    await queueQuery(
      `INSERT INTO id_change_requests
         (user_id, requested_value, current_value, doc_type, image_data, back_image_data, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [userId, requested, current, docType, front, back, reason],
    )
  }
  return getIdChangeState(userId)
}

/**
 * Withdraw a pending request.
 *
 * Only a pending one: a decided request is the record that the decision happened, and
 * letting a user delete the rejection they were just given would erase the reason they
 * are supposed to act on.
 */
export async function cancelIdChangeRequest(userId: string): Promise<IdChangeState> {
  if (!isUuid(userId)) throw new IdChangeError('Invalid user')
  const { rowCount } = await queueQuery(
    `DELETE FROM id_change_requests WHERE user_id = $1 AND status = 'pending'`,
    [userId],
  )
  if (!rowCount) throw new IdChangeError('You have no request waiting for review')
  return getIdChangeState(userId)
}

/** Whether a value the client sent matches what is already stored — used by the
 *  profile PATCH to tell an unchanged echo from an attempted edit. */
export function matchesStoredDocument(submitted: unknown, stored: unknown): boolean {
  return canonicalDocumentNumber(submitted) === canonicalDocumentNumber(stored)
}


// ---- /ops additions, ported from quickin-frontend 21 Aug 2026 ----

export interface AdminIdChangeRow {
  id: string
  user_id: string
  user_name: string | null
  user_email: string | null
  /** Whether this account is verified — context for how much the number matters. */
  verification_status: string
  current_value: string | null
  requested_value: string
  doc_type: string
  reason: string | null
  status: IdChangeStatus
  notes: string | null
  has_front: boolean
  has_back: boolean
  submitted_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  /** Present only on the single-request read — the list omits them, see below. */
  image_data?: string | null
  back_image_data?: string | null
}

/** One request WITH its document images, for the reviewer who opened it. */
export async function adminGetIdChangeRequest(id: string): Promise<AdminIdChangeRow | null> {
  if (!isUuid(id)) throw new IdChangeError('Invalid request')
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS}, r.image_data, r.back_image_data
       FROM id_change_requests r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.id = $1`,
    [id],
  )
  return (rows[0] as AdminIdChangeRow | undefined) ?? null
}

/** The queue: everything awaiting a decision, oldest first so it matches the
 *  "waited 3 days" the alert centre shows. Empty when the table doesn't exist yet. */
export async function adminListIdChangeRequests(status: IdChangeStatus = 'pending'): Promise<AdminIdChangeRow[]> {
  try {
    const { rows } = await pool.query(
      `SELECT ${LIST_COLUMNS}
         FROM id_change_requests r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.status = $1
        ORDER BY r.submitted_at ASC
        LIMIT 200`,
      [normalizeIdChangeStatus(status)],
    )
    return rows as AdminIdChangeRow[]
  } catch {
    // Same contract as countOpenDisputes: an un-migrated database shows an empty
    // queue rather than breaking the verifications screen around it.
    return []
  }
}

/** How many requests need someone — the Alerts count. Zero when un-migrated. */
export async function countPendingIdChanges(): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM id_change_requests WHERE status = 'pending'`,
    )
    return Number(rows[0]?.n ?? 0)
  } catch {
    return 0
  }
}

/** When the oldest waiting request arrived, so the alert can say "3 days". */
export async function oldestPendingIdChangeAt(): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      `SELECT to_char((MIN(submitted_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t
         FROM id_change_requests WHERE status = 'pending'`,
    )
    return (rows[0]?.t as string | null) ?? null
  } catch {
    return null
  }
}

/**
 * Decide a request.
 *
 * Approving writes the new number onto the user and stamps the row; rejecting stamps
 * the row and leaves the profile untouched. Both happen in ONE transaction, because a
 * half-applied decision — profile updated, request still pending — would let a second
 * operator approve the same change again onto a value that had already moved.
 *
 * `verification_status` is deliberately NOT touched. The operator has just examined a
 * document to approve this, which is the same act that grants verification; resetting
 * a verified host to pending here would trip the publish gate in
 * host-verification-core and pull their live listings off the market as a side effect
 * of correcting a number. Losing verification stays something reviewVerification does
 * on purpose, never something a typo fix causes by accident.
 *
 * Only a PENDING request can be decided — the guard is in the UPDATE's WHERE clause
 * rather than a preceding SELECT, so two operators clicking at once cannot both win.
 */
export async function reviewIdChangeRequest(
  requestId: string,
  action: IdChangeAction | string,
  note: string | null,
  actor: string,
): Promise<{ userId: string; status: IdChangeStatus; value: string | null }> {
  if (!isUuid(requestId)) throw new IdChangeError('Invalid request')
  const decision = normalizeIdChangeAction(action)
  const cleanNote = normalizeIdChangeNote(note)
  // A rejection the user cannot act on is a dead end — they are never told what to fix.
  assertRejectionExplained(decision, cleanNote)
  const status = statusForIdChangeAction(decision)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE id_change_requests
          SET status = $2, notes = $3, reviewed_at = now(), reviewed_by = $4
        WHERE id = $1 AND status = 'pending'
        RETURNING user_id, requested_value`,
      [requestId, status, cleanNote, actor],
    )
    const row = rows[0]
    if (!row) {
      // Either it never existed or someone else already decided it. Both mean this
      // operator's click must not apply.
      throw new IdChangeError('That request has already been decided')
    }
    const userId = String(row.user_id)
    const requested = String(row.requested_value)

    if (decision === 'approve') {
      await client.query(`UPDATE users SET id_document = $2 WHERE id = $1`, [userId, requested])
    }
    await client.query('COMMIT')

    // Outside the transaction: a failed notification must not roll back a decision
    // that has already been made.
    await notifyDecision(
      userId,
      `id_change_${status}`,
      decision === 'approve' ? 'ID number updated' : 'ID change request rejected',
      decision === 'approve'
        ? `Your ID number is now ${requested}.`
        : cleanNote ?? 'Your request to change your ID number was not approved.',
    )

    return { userId, status, value: decision === 'approve' ? requested : null }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw err
  } finally {
    client.release()
  }
}

// The list deliberately does NOT select image_data. Each row carries up to 3.5MB of
// inline base64, and /ops polls on a 30-second timer — sending twenty of them per poll
// would be tens of megabytes a minute per operator. The documents are fetched one at a
// time when a reviewer opens a request.
const LIST_COLUMNS = `
  r.id, r.user_id, u.full_name AS user_name, u.email AS user_email,
  COALESCE(u.verification_status, 'unverified') AS verification_status,
  r.current_value, r.requested_value, r.doc_type, r.reason, r.status, r.notes,
  -- Which documents exist, so the reviewer sees a button per document without the
  -- bytes riding along. image_data is NOT NULL by schema, so has_front is really
  -- "there is always one" — it is projected anyway so the UI can treat both the same.
  (r.image_data IS NOT NULL) AS has_front,
  (r.back_image_data IS NOT NULL) AS has_back,
  to_char(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
  to_char(r.reviewed_at AT TIME ZONE 'UTC',  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
  r.reviewed_by`

/**
 * Tell the user what was decided — and never let that failing undo the decision.
 *
 * Written here rather than imported from db.ts, which already imports this module for
 * its alert counts; going back the other way would be a cycle. It also needs the
 * swallow-errors contract that db.ts's own createNotification does not have: the
 * decision is already committed by the time this runs, so throwing would surface a
 * failure for work that actually succeeded.
 */
async function notifyDecision(
  userId: string,
  type: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, body, '/profile'],
    )
  } catch (e) {
    console.error('id change notification failed (ignored):', e)
  }
}
