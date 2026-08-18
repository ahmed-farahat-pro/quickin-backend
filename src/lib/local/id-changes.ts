import { pool } from './pool'
import {
  IdChangeError,
  assertActuallyChanges,
  assertReviewable,
  canonicalDocumentNumber,
  normalizeDocumentImage,
  normalizeDocumentNumber,
  normalizeIdChangeReason,
  normalizeIdChangeStatus,
  type IdChangeStatus,
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
}

// Images are excluded from every read below. A user re-opening their profile does not
// need the megabyte of base64 they uploaded sent back to them, and the /ops reviewer
// fetches them through its own query.
const REQUEST_COLUMNS = `
  id, status, requested_value, current_value, doc_type, reason, notes,
  to_char(submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
  to_char(reviewed_at,  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at`

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

/** The user's current ID number plus the state of their latest change request. */
export async function getIdChangeState(userId: string): Promise<IdChangeState> {
  if (!isUuid(userId)) throw new IdChangeError('Invalid user')
  const [profile, request] = await Promise.all([
    pool.query(`SELECT id_document FROM users WHERE id = $1`, [userId]),
    pool.query(
      `SELECT ${REQUEST_COLUMNS} FROM id_change_requests
        WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
      [userId],
    ),
  ])
  const latest = rowToRequest(request.rows[0])
  return {
    current: (profile.rows[0]?.id_document as string) ?? null,
    request: latest,
    can_request: latest?.status !== 'pending',
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

  const pending = await pool.query(
    `SELECT id FROM id_change_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
    [userId],
  )
  if (pending.rows[0]) {
    await pool.query(
      `UPDATE id_change_requests
          SET requested_value = $2, current_value = $3, doc_type = $4,
              image_data = $5, back_image_data = $6, reason = $7,
              status = 'pending', notes = NULL,
              submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL
        WHERE id = $1`,
      [pending.rows[0].id, requested, current, docType, front, back, reason],
    )
  } else {
    await pool.query(
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
  const { rowCount } = await pool.query(
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
