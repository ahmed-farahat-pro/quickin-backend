import { pool } from './pool'
import { createNotification } from './notifications'
import { sendPush } from './push'
import { sendNotificationEmail } from './mailer'
import {
  cairoDate,
  closureFor,
  hoursWaiting,
  nudgeCopy,
  shouldNudge,
  staleCutoff,
  statusesFor,
  type ListFilter,
} from './host-response-alerts-core'

// Host response alerts — booking requests a host has left unanswered for 24h+.
//
// Stored rows, not a derived count like the rest of the alert centre, because staff
// need to mark an alert handled ("called the host") and see which hosts ignore
// guests again and again. The sweep below is the only writer of new rows; it runs
// nightly from GET /api/cron/host-response-alerts. Rules live in
// host-response-alerts-core.ts. See README → Host response alerts.

const WEB_URL = process.env.WEB_URL || 'https://quickin-frontend.vercel.app'
const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)
const ts = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`

export interface SweepResult {
  today: string
  resolved: number
  expired: number
  /** New alerts this run. */
  opened: number
  /** Every request currently stale and unanswered, new or not. */
  stale: number
  nudged: number
}

/**
 * The nightly pass. In order:
 *  1. close every active alert whose booking was answered or whose check-in passed;
 *  2. open (or refresh) an alert for every pending request older than 24h whose
 *     check-in is today or later;
 *  3. remind each of those hosts, at most once per night.
 * Safe to run repeatedly — a second run the same night opens nothing new and
 * nudges no one.
 */
export async function runHostResponseSweep(now: Date = new Date()): Promise<SweepResult> {
  const nowMs = now.getTime()
  const today = cairoDate(nowMs)

  // 1. Close. Decided in JS by closureFor so the rule is the tested one.
  const { rows: active } = await pool.query(
    `SELECT a.id, b.status, b.check_in::text AS check_in
       FROM host_response_alerts a JOIN bookings b ON b.id = a.booking_id
      WHERE a.status IN ('open', 'handled')`,
  )
  let resolved = 0
  let expired = 0
  for (const row of active) {
    const c = closureFor({ status: row.status, checkIn: row.check_in }, today)
    if (!c) continue
    await pool.query(
      `UPDATE host_response_alerts
          SET status = $2, closed_reason = $3, closed_at = now()
        WHERE id = $1 AND status IN ('open', 'handled')`,
      [row.id, c.status, c.reason],
    )
    if (c.status === 'resolved') resolved++
    else expired++
  }

  // 2. Open or refresh. A booking reopened to pending after a decline (the guest
  //    re-uploaded a proof) finds its old `resolved` row and reopens it; an `expired`
  //    one can't match, since its check-in is in the past.
  const { rows: stale } = await pool.query(
    `INSERT INTO host_response_alerts (booking_id, host_id)
     SELECT b.id, l.host_id
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.status = 'pending'
        AND b.created_at <= $1
        AND b.check_in >= $2::date
     ON CONFLICT (booking_id) DO UPDATE
        SET last_flagged_at = now(),
            status = CASE WHEN host_response_alerts.status = 'resolved' THEN 'open'
                          ELSE host_response_alerts.status END,
            closed_at = CASE WHEN host_response_alerts.status = 'resolved' THEN NULL
                             ELSE host_response_alerts.closed_at END,
            closed_reason = CASE WHEN host_response_alerts.status = 'resolved' THEN NULL
                                 ELSE host_response_alerts.closed_reason END
      WHERE host_response_alerts.status <> 'expired'
     RETURNING id, booking_id, host_id, last_nudged_at, (xmax = 0) AS inserted`,
    [staleCutoff(nowMs).toISOString(), today],
  )
  const opened = stale.filter((r) => r.inserted).length

  // 3. Nudge.
  let nudged = 0
  for (const row of stale) {
    if (!row.host_id || !shouldNudge(row.last_nudged_at, nowMs)) continue
    const { rows: b } = await pool.query(
      `SELECT b.created_at, l.title, u.email
         FROM bookings b JOIN listings l ON l.id = b.listing_id
         LEFT JOIN users u ON u.id = l.host_id
        WHERE b.id = $1`,
      [row.booking_id],
    )
    if (!b[0]) continue
    const copy = nudgeCopy(b[0].title, hoursWaiting(b[0].created_at, nowMs))
    // Each channel is best-effort; one failing must not stop the others or the sweep.
    await createNotification(row.host_id, { type: 'booking_request_reminder', ...copy, link: '/host' })
    await sendPush(row.host_id, { ...copy, link: '/host' })
    if (b[0].email) {
      try {
        await sendNotificationEmail(
          b[0].email,
          'A guest is waiting for your answer — Quick In',
          copy.title,
          [copy.body, 'Open your host dashboard to accept or decline the request.'],
          { label: 'Open host dashboard', url: `${WEB_URL}/host` },
        )
      } catch (err) {
        console.error('host-response nudge email:', err)
      }
    }
    await pool.query(
      `UPDATE host_response_alerts
          SET nudge_count = nudge_count + 1, last_nudged_at = now()
        WHERE id = $1`,
      [row.id],
    )
    nudged++
  }

  return { today, resolved, expired, opened, stale: stale.length, nudged }
}

export interface HostResponseAlert {
  id: string
  booking_id: string
  status: string
  first_flagged_at: string
  last_flagged_at: string
  nudge_count: number
  last_nudged_at: string | null
  handled_by_name: string | null
  handled_at: string | null
  handled_note: string | null
  closed_at: string | null
  closed_reason: string | null
  requested_at: string
  booking_status: string
  check_in: string
  check_out: string
  guests: number
  total_price: number
  listing_id: string
  listing_title: string | null
  host_id: string | null
  host_name: string | null
  host_email: string | null
  host_phone: string | null
  guest_name: string | null
  /** How many alerts this host has had in total — the repeat-offender signal. */
  host_alert_count: number
}

const ALERT_SELECT = `
  SELECT a.id, a.booking_id, a.status,
         ${ts('a.first_flagged_at')} AS first_flagged_at,
         ${ts('a.last_flagged_at')} AS last_flagged_at,
         a.nudge_count, ${ts('a.last_nudged_at')} AS last_nudged_at,
         a.handled_by_name, ${ts('a.handled_at')} AS handled_at, a.handled_note,
         ${ts('a.closed_at')} AS closed_at, a.closed_reason,
         ${ts('b.created_at')} AS requested_at, b.status AS booking_status,
         b.check_in::text AS check_in, b.check_out::text AS check_out,
         b.guests, b.total_price::float8 AS total_price,
         l.id AS listing_id, l.title AS listing_title,
         a.host_id, h.full_name AS host_name, h.email AS host_email, h.phone AS host_phone,
         g.full_name AS guest_name,
         (SELECT COUNT(*)::int FROM host_response_alerts x WHERE x.host_id = a.host_id) AS host_alert_count
    FROM host_response_alerts a
    JOIN bookings b ON b.id = a.booking_id
    JOIN listings l ON l.id = b.listing_id
    LEFT JOIN users h ON h.id = a.host_id
    LEFT JOIN users g ON g.id = b.user_id`

export async function adminListHostResponseAlerts(filter: ListFilter): Promise<HostResponseAlert[]> {
  const { rows } = await pool.query(
    `${ALERT_SELECT}
      WHERE a.status = ANY($1::text[])
      ORDER BY b.created_at ASC
      LIMIT 500`,
    [statusesFor(filter)],
  )
  return rows as HostResponseAlert[]
}

export async function adminGetHostResponseAlert(id: string): Promise<HostResponseAlert | null> {
  if (!isUuid(id)) return null
  const { rows } = await pool.query(`${ALERT_SELECT} WHERE a.id = $1`, [id])
  return (rows[0] as HostResponseAlert) ?? null
}

/**
 * open → handled, compare-and-set so two operators can't both act on a stale
 * screen. Returns false when the alert was no longer open (someone else handled
 * it, or the host answered and the sweep closed it).
 */
export async function markHostResponseAlertHandled(args: {
  id: string
  note: string
  actor: string
  actorName: string
}): Promise<boolean> {
  if (!isUuid(args.id)) return false
  const { rowCount } = await pool.query(
    `UPDATE host_response_alerts
        SET status = 'handled', handled_by = $2, handled_by_name = $3,
            handled_at = now(), handled_note = $4
      WHERE id = $1 AND status = 'open'`,
    [args.id, args.actor, args.actorName, args.note],
  )
  return (rowCount ?? 0) > 0
}

/** Open alerts, for the alert centre. 0 when the table doesn't exist yet, so the
 *  console degrades instead of 500ing on a database the migration hasn't reached. */
export async function countOpenHostResponseAlerts(): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM host_response_alerts WHERE status = 'open'`,
    )
    return Number(rows[0]?.n ?? 0)
  } catch {
    return 0
  }
}

/** When the oldest still-open request was made. Null without the table. */
export async function oldestOpenHostResponseAlertAt(): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      `SELECT ${ts('MIN(b.created_at)')} AS t
         FROM host_response_alerts a JOIN bookings b ON b.id = a.booking_id
        WHERE a.status = 'open'`,
    )
    return (rows[0]?.t as string | null) ?? null
  } catch {
    return null
  }
}
