import { pool } from './pool'
import {
  DisputeInputError,
  canDisputeBooking,
  bookingIneligibleReason,
  normalizeNote,
  validateFiling,
  type DisputeStatus,
} from './disputes-core'

// Guest disputes — filing one, and reading your own.
//
// Separate from db.ts because the /ops side of this lives only in the web
// project, and because disputes touch bookings, users and their own two tables;
// keeping the SQL together makes the lifecycle readable in one file.
//
// Deliberately NOT content-guarded. Every other free-text surface runs through
// contentguard, but a dispute is addressed to QuickIn staff rather than to the
// other party, and it routinely needs to quote contact details as EVIDENCE
// ("the host told me to pay him directly on 010…"). Guarding it would suppress
// exactly the thing an investigator needs. See README → Guest disputes.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

export interface DisputeEvent {
  id: string
  from_status: string | null
  to_status: string
  note: string | null
  actor: string
  actor_name: string | null
  created_at: string
}

export interface Dispute {
  id: string
  booking_id: string
  guest_id: string
  category: string
  description: string
  photos: string[]
  status: string
  resolution: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  /** Joined for display — a guest looking at a list needs to know which stay. */
  listing_title?: string | null
  reservation_code?: string | null
  check_in?: string | null
  check_out?: string | null
}

const DISPUTE_COLS = `
  d.id, d.booking_id, d.guest_id, d.category, d.description,
  COALESCE(d.photos, '{}') AS photos, d.status, d.resolution,
  to_char(d.created_at,  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(d.updated_at,  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
  to_char(d.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS resolved_at`

/**
 * File a dispute against a booking.
 *
 * The booking must belong to this guest and be confirmed or completed — see
 * `canDisputeBooking`. Both the dispute and its opening history row are written
 * in one transaction, so a dispute can never exist with an empty timeline.
 */
export async function fileDispute(args: {
  guestId: string
  bookingId: string
  category: unknown
  description: unknown
  photos?: unknown
}): Promise<Dispute> {
  const { guestId, bookingId } = args
  if (!isUuid(guestId) || !isUuid(bookingId)) throw new DisputeInputError('Invalid reservation')

  // Validate the input BEFORE touching the database, so a malformed filing costs
  // nothing and the guest gets the specific reason.
  const { category, description, photos } = validateFiling(args)

  const { rows: br } = await pool.query(
    `SELECT id, user_id, status FROM bookings WHERE id = $1`,
    [bookingId],
  )
  const booking = br[0] as { id: string; user_id: string; status: string } | undefined
  if (!booking) throw new DisputeInputError('Reservation not found')
  if (booking.user_id !== guestId) throw new DisputeInputError('You can only raise an issue on your own reservation')
  if (!canDisputeBooking(booking.status)) throw new DisputeInputError(bookingIneligibleReason(booking.status))

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const ins = await client.query(
      `INSERT INTO disputes (booking_id, guest_id, category, description, photos)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [bookingId, guestId, category, description, photos],
    )
    const id = ins.rows[0].id as string
    // The opening history row. from_status NULL — it came from nowhere.
    await client.query(
      `INSERT INTO dispute_events (dispute_id, from_status, to_status, actor, actor_name)
       VALUES ($1, NULL, 'open', $2, (SELECT COALESCE(NULLIF(full_name, ''), email) FROM users WHERE id = $3))`,
      [id, `guest:${guestId}`, guestId],
    )
    await client.query('COMMIT')
    const out = await getDisputeForGuest(guestId, id)
    if (!out) throw new Error('Dispute was filed but could not be read back')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Every dispute this guest has filed, newest first, with the stay it is about. */
export async function listDisputesForGuest(guestId: string): Promise<Dispute[]> {
  if (!isUuid(guestId)) return []
  const { rows } = await pool.query(
    `SELECT ${DISPUTE_COLS},
            l.title AS listing_title,
            NULLIF(b.reservation_code, '') AS reservation_code,
            to_char(b.check_in,  'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out
       FROM disputes d
       JOIN bookings b ON b.id = d.booking_id
       LEFT JOIN listings l ON l.id = b.listing_id
      WHERE d.guest_id = $1
      ORDER BY d.created_at DESC
      LIMIT 100`,
    [guestId],
  )
  return rows as Dispute[]
}

/** One dispute, only if it belongs to this guest. */
export async function getDisputeForGuest(guestId: string, disputeId: string): Promise<Dispute | null> {
  if (!isUuid(guestId) || !isUuid(disputeId)) return null
  const { rows } = await pool.query(
    `SELECT ${DISPUTE_COLS},
            l.title AS listing_title,
            NULLIF(b.reservation_code, '') AS reservation_code,
            to_char(b.check_in,  'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out
       FROM disputes d
       JOIN bookings b ON b.id = d.booking_id
       LEFT JOIN listings l ON l.id = b.listing_id
      WHERE d.id = $1 AND d.guest_id = $2`,
    [disputeId, guestId],
  )
  return (rows[0] as Dispute | undefined) ?? null
}

/**
 * The history of a dispute, oldest first.
 *
 * `note` is included: an admin's note on a status change is written to be read
 * by the guest ("we've contacted the host"), which is why the resolution and the
 * notes are not internal-only. Anything genuinely internal belongs in
 * staff_audit_log, not here.
 */
export async function listDisputeEvents(disputeId: string): Promise<DisputeEvent[]> {
  if (!isUuid(disputeId)) return []
  const { rows } = await pool.query(
    `SELECT id, from_status, to_status, note, actor, actor_name,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM dispute_events WHERE dispute_id = $1
      -- Qualified on purpose: the SELECT above aliases to_char(created_at, …)
      -- AS created_at, and Postgres resolves a BARE identifier in ORDER BY to the
      -- output column first. Unqualified, this would sort by the second-precision
      -- STRING, so events in the same second fell back to the uuid tiebreak and the
      -- timeline came out scrambled.
      ORDER BY dispute_events.created_at ASC, id ASC
      LIMIT 200`,
    [disputeId],
  )
  return rows as DisputeEvent[]
}

/**
 * Which of this guest's bookings can still have a dispute filed against them,
 * and which already have one. Lets a reservations screen show the right control
 * without a request per booking.
 */
export async function disputableBookingIds(guestId: string): Promise<{ eligible: string[]; existing: Record<string, string> }> {
  if (!isUuid(guestId)) return { eligible: [], existing: {} }
  const { rows } = await pool.query(
    `SELECT b.id, b.status,
            (SELECT d.status FROM disputes d
              WHERE d.booking_id = b.id ORDER BY d.created_at DESC LIMIT 1) AS dispute_status
       FROM bookings b WHERE b.user_id = $1`,
    [guestId],
  )
  const eligible: string[] = []
  const existing: Record<string, string> = {}
  for (const r of rows as { id: string; status: string; dispute_status: string | null }[]) {
    if (canDisputeBooking(r.status)) eligible.push(r.id)
    if (r.dispute_status) existing[r.id] = r.dispute_status
  }
  return { eligible, existing }
}

/**
 * Record a status change and its history row in one transaction.
 *
 * Shared by the /ops route in the web project; it lives here so the transition
 * and its history row can never come apart. `expectedFrom` is the status the
 * caller believed it was in — supplying it makes the update a compare-and-set,
 * so two operators acting at once can't both "resolve" from different states.
 */
export async function applyDisputeTransition(args: {
  disputeId: string
  to: DisputeStatus
  expectedFrom: string
  note?: unknown
  actor: string
  actorName: string | null
  /** Written to disputes.resolution when moving to resolved. Shown to the guest. */
  resolution?: unknown
}): Promise<{ ok: boolean; conflict?: string }> {
  const { disputeId, to, expectedFrom } = args
  if (!isUuid(disputeId)) return { ok: false, conflict: 'Invalid dispute' }
  const note = normalizeNote(args.note)
  const resolution = to === 'resolved' ? normalizeNote(args.resolution ?? args.note) : null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const upd = await client.query(
      `UPDATE disputes
          SET status = $2,
              updated_at = now(),
              resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END,
              resolution  = COALESCE($4, resolution)
        WHERE id = $1 AND status = $3
        RETURNING id`,
      [disputeId, to, expectedFrom, resolution],
    )
    if (!upd.rows[0]) {
      await client.query('ROLLBACK')
      // Either it doesn't exist or someone else moved it first. Both mean the
      // operator is looking at a stale screen, which is what they need told.
      return { ok: false, conflict: 'This dispute changed since you loaded it. Refresh and try again.' }
    }
    await client.query(
      `INSERT INTO dispute_events (dispute_id, from_status, to_status, note, actor, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [disputeId, expectedFrom, to, note, args.actor, args.actorName],
    )
    await client.query('COMMIT')
    return { ok: true }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
