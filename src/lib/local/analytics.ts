// /ops analytics reports — B1 bookings, B2 payments, B3 cancellations.
//
// Every query here builds its WHERE from buildReportWhere() and its predicates from
// the constants in analytics-core.ts, so a filter means the same thing in every
// report and the `paid_at`-cleared-on-refund trap cannot be reintroduced.
// The pure half (parsing, clause building, money math, CSV) lives in
// analytics-core.ts and is unit-tested; this file is the thin SQL layer.
import { pool } from './pool'
import { bookingCommissionSql, bookingRateSql, sqlWithCommission } from './commission-core'
import {
  ACTIVE_SQL,
  MONEY_AT_SQL,
  PAID_SQL,
  REFUNDED_SQL,
  RESORT_JOIN,
  RESORT_KEY_SQL,
  RESORT_LABEL_SQL,
  bucketSql,
  buildReportWhere,
  dateExpr,
  type DateColumn,
  type ReportFilter,
} from './analytics-core'

/** bookings ⋈ listings ⋈ resorts — every report reads this shape. */
const FROM_SQL = `FROM bookings b JOIN listings l ON l.id = b.listing_id ${RESORT_JOIN}`

/**
 * What the GUEST was charged for a booking: the host's raw total_price marked up
 * at that booking's own snapshotted rate.
 *
 * Every "gross"/"value" figure in these reports is this, never the bare
 * total_price — an operator reading a revenue number means the money that changed
 * hands, and total_price is the host's side of it. See commission-core.ts.
 */
const GUEST_SQL = sqlWithCommission('b.total_price', bookingRateSql())

/** Assemble a full WHERE from the shared filter plus any report-specific clauses. */
function where(f: ReportFilter, dateColumn: DateColumn, extra: string[] = []) {
  const { clauses, params } = buildReportWhere(f, dateColumn)
  return { sql: [...clauses, ...extra].join(' AND '), params }
}

export interface TrendPoint {
  bucket: string
  [metric: string]: string | number
}
export interface BreakdownRow {
  key: string
  label: string
  count: number
  value: number
}

// ---- B1: bookings -----------------------------------------------------------

export interface BookingsReport {
  totals: {
    total: number
    active: number
    completed: number
    cancelled: number
    rejected: number
    pending: number
    confirmed: number
    gross: number
  }
  trend: TrendPoint[]
  byResort: BreakdownRow[]
  byStatus: BreakdownRow[]
}

/**
 * B1 — totals for active / completed / cancelled, filterable by date, resort and host.
 *
 * "Active" is not a status: BOOKING_STATUSES has no such value. It means a
 * confirmed booking whose stay has not ended yet (ACTIVE_SQL), which is what an
 * operator means by the word. `total` counts every booking in the window.
 */
export async function bookingsReport(f: ReportFilter): Promise<BookingsReport> {
  const w = where(f, 'created_at')
  const bucket = bucketSql(f.granularity, dateExpr('created_at'))

  const [totals, trend, byResort, byStatus] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ${ACTIVE_SQL})::int          AS active,
              count(*) FILTER (WHERE b.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE b.status = 'rejected')::int  AS rejected,
              count(*) FILTER (WHERE b.status = 'pending')::int   AS pending,
              count(*) FILTER (WHERE b.status = 'confirmed')::int AS confirmed,
              COALESCE(sum(${GUEST_SQL}), 0)::float8             AS gross
         ${FROM_SQL} WHERE ${w.sql}`,
      w.params
    ),
    pool.query(
      `SELECT to_char(${bucket}, 'YYYY-MM-DD') AS bucket,
              count(*)::int AS count,
              count(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled,
              COALESCE(sum(${GUEST_SQL}), 0)::float8 AS gross
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1 ORDER BY 1`,
      w.params
    ),
    pool.query(
      `SELECT ${RESORT_KEY_SQL} AS key, ${RESORT_LABEL_SQL} AS label,
              count(*)::int AS count, COALESCE(sum(${GUEST_SQL}), 0)::float8 AS value
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1, 2 ORDER BY 3 DESC, 2`,
      w.params
    ),
    pool.query(
      `SELECT b.status AS key, b.status AS label,
              count(*)::int AS count, COALESCE(sum(${GUEST_SQL}), 0)::float8 AS value
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1 ORDER BY 3 DESC`,
      w.params
    ),
  ])

  return {
    totals: totals.rows[0] as BookingsReport['totals'],
    trend: trend.rows as TrendPoint[],
    byResort: byResort.rows as BreakdownRow[],
    byStatus: byStatus.rows as BreakdownRow[],
  }
}

// ---- B2: payments -----------------------------------------------------------

export interface RevenueReport {
  totals: {
    /** Commission-inclusive — the money guests actually handed over. */
    gross: number
    /** The platform's margin: gross − hostPayouts. */
    commission: number
    /** What the hosts are owed: their raw price, in full. */
    hostPayouts: number
    refunded: number
    paidCount: number
    refundedCount: number
    pendingPayout: number
    settledPayout: number
  }
  trend: TrendPoint[]
  byResort: BreakdownRow[]
}

/**
 * B2 — revenue, commission, refunds and a payout split.
 *
 * THE MONEY MODEL. The commission is a MARKUP, not a deduction: bookings.total_price
 * is the host's RAW price and they are paid it in full, while the guest was charged
 * that price marked up and rounded to the nearest 10 EGP. So:
 *
 *     gross (guest paid) = withCommission(total_price)
 *     hostPayouts        = total_price          ← the whole thing, not 90% of it
 *     commission         = gross − hostPayouts  ← NOT total_price × rate
 *
 * This report used to read `gross = sum(total_price)` and `hostNet = gross −
 * commission`, which was the old fee model: it understated hosts by the commission
 * and reported guest revenue as if the markup had never been charged.
 *
 * Three deliberate choices, unchanged:
 *  - Money is bucketed by MONEY_AT_SQL, not paid_at: a refund clears paid_at, so
 *    bucketing on it would drop every refunded booking off the chart.
 *  - Commission uses the per-booking snapshot, falling back to the live rate for
 *    rows taken before the snapshot existed — so changing the rate never rewrites
 *    history.
 *  - Refunds are recomputed from refund_percent. bookings.refund_amount is NULL for
 *    every web-originated cancellation and can never be trusted. A refund returns a
 *    percentage of what the GUEST paid, so it is a percentage of the marked-up
 *    figure.
 *
 * "Pending payout" is a DERIVED ESTIMATE, not a ledger: there is no payouts table.
 * It is simply the host's price on paid bookings whose stay has not ended. Label it
 * as an estimate wherever it is shown.
 */
export async function revenueReport(f: ReportFilter): Promise<RevenueReport> {
  const w = where(f, 'money_at')
  const bucket = bucketSql(f.granularity, MONEY_AT_SQL)
  const GUEST = GUEST_SQL
  const GROSS = `COALESCE(sum(${GUEST}) FILTER (WHERE ${PAID_SQL}), 0)::float8`
  const HOST_PAYOUTS = `COALESCE(sum(b.total_price) FILTER (WHERE ${PAID_SQL}), 0)::float8`
  const COMMISSION = `COALESCE(sum(${bookingCommissionSql()}) FILTER (WHERE ${PAID_SQL}), 0)::float8`
  const REFUNDED = `COALESCE(sum(${GUEST} * COALESCE(b.refund_percent, 0) / 100.0) FILTER (WHERE ${REFUNDED_SQL} OR b.refund_percent > 0), 0)::float8`

  const [totals, trend, byResort] = await Promise.all([
    pool.query(
      `SELECT ${GROSS} AS gross,
              ${COMMISSION} AS commission,
              ${HOST_PAYOUTS} AS "hostPayouts",
              ${REFUNDED} AS refunded,
              count(*) FILTER (WHERE ${PAID_SQL})::int     AS "paidCount",
              count(*) FILTER (WHERE ${REFUNDED_SQL})::int AS "refundedCount",
              -- Derived estimate only: no payouts table exists. The host is owed
              -- their raw price in full — the markup was never theirs to lose.
              COALESCE(sum(b.total_price)
                FILTER (WHERE ${PAID_SQL} AND b.check_out >= CURRENT_DATE), 0)::float8 AS "pendingPayout",
              COALESCE(sum(b.total_price)
                FILTER (WHERE ${PAID_SQL} AND b.check_out < CURRENT_DATE), 0)::float8 AS "settledPayout"
         ${FROM_SQL} WHERE ${w.sql}`,
      w.params
    ),
    pool.query(
      `SELECT to_char(${bucket}, 'YYYY-MM-DD') AS bucket,
              ${GROSS} AS gross, ${COMMISSION} AS commission, ${REFUNDED} AS refunded
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1 ORDER BY 1`,
      w.params
    ),
    pool.query(
      `SELECT ${RESORT_KEY_SQL} AS key, ${RESORT_LABEL_SQL} AS label,
              count(*) FILTER (WHERE ${PAID_SQL})::int AS count, ${GROSS} AS value
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1, 2 ORDER BY 4 DESC, 2`,
      w.params
    ),
  ])

  return {
    totals: totals.rows[0] as RevenueReport['totals'],
    trend: trend.rows as TrendPoint[],
    byResort: byResort.rows as BreakdownRow[],
  }
}

// ---- B3: cancellations ------------------------------------------------------

export interface CancellationsReport {
  totals: {
    cancelled: number
    totalInWindow: number
    rate: number
    refundedValue: number
  }
  trend: TrendPoint[]
  byActor: BreakdownRow[]
  byPolicy: BreakdownRow[]
  byResort: BreakdownRow[]
}

/**
 * B3 — cancellation count and rate, split by policy and by who cancelled.
 *
 * Both splits show "Unknown" for bookings taken before the tracking columns
 * existed; nothing is back-filled, because the listing's CURRENT policy is not
 * evidence of what it was at the time and there is no record of past actors.
 *
 * The rate divides cancellations in the window (by cancelled_at) by bookings
 * CREATED in the same window — two different date axes on purpose, since a booking
 * cancelled today may have been made last year. It is a period activity ratio, not
 * a cohort rate; label it that way.
 */
export async function cancellationsReport(f: ReportFilter): Promise<CancellationsReport> {
  const w = where(f, 'cancelled_at', [`b.cancelled_at IS NOT NULL`])
  const created = where(f, 'created_at')
  const bucket = bucketSql(f.granularity, dateExpr('cancelled_at'))
  const REFUND_VALUE = `COALESCE(sum(b.total_price * COALESCE(b.refund_percent, 0) / 100.0), 0)::float8`

  const [totals, createdCount, trend, byActor, byPolicy, byResort] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS cancelled, ${REFUND_VALUE} AS "refundedValue"
         ${FROM_SQL} WHERE ${w.sql}`,
      w.params
    ),
    pool.query(`SELECT count(*)::int AS n ${FROM_SQL} WHERE ${created.sql}`, created.params),
    pool.query(
      `SELECT to_char(${bucket}, 'YYYY-MM-DD') AS bucket, count(*)::int AS count
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1 ORDER BY 1`,
      w.params
    ),
    pool.query(
      `SELECT COALESCE(b.cancelled_by_role, 'unknown') AS key,
              CASE COALESCE(b.cancelled_by_role, 'unknown')
                WHEN 'guest' THEN 'Guest' WHEN 'host' THEN 'Host'
                WHEN 'admin' THEN 'Admin' WHEN 'system' THEN 'System'
                ELSE 'Unknown (before tracking)' END AS label,
              count(*)::int AS count, ${REFUND_VALUE} AS value
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1 ORDER BY 3 DESC`,
      w.params
    ),
    pool.query(
      // The snapshot, NOT l.cancellation_policy — the listing's current policy is
      // not what was in force when the booking was taken.
      `SELECT COALESCE(b.cancellation_policy, 'unknown') AS key,
              CASE COALESCE(b.cancellation_policy, 'unknown')
                WHEN 'unknown' THEN 'Unknown (before tracking)'
                ELSE initcap(COALESCE(b.cancellation_policy, '')) END AS label,
              count(*)::int AS count, ${REFUND_VALUE} AS value
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1, 2 ORDER BY 3 DESC`,
      w.params
    ),
    pool.query(
      `SELECT ${RESORT_KEY_SQL} AS key, ${RESORT_LABEL_SQL} AS label,
              count(*)::int AS count, ${REFUND_VALUE} AS value
         ${FROM_SQL} WHERE ${w.sql}
        GROUP BY 1, 2 ORDER BY 3 DESC, 2`,
      w.params
    ),
  ])

  const cancelled = totals.rows[0].cancelled as number
  const totalInWindow = createdCount.rows[0].n as number
  return {
    totals: {
      cancelled,
      totalInWindow,
      rate: totalInWindow > 0 ? Math.round((cancelled / totalInWindow) * 1000) / 10 : 0,
      refundedValue: totals.rows[0].refundedValue as number,
    },
    trend: trend.rows as TrendPoint[],
    byActor: byActor.rows as BreakdownRow[],
    byPolicy: byPolicy.rows as BreakdownRow[],
    byResort: byResort.rows as BreakdownRow[],
  }
}

// ---- B4: the flat shape the exporter consumes -------------------------------

export interface ReportRows {
  headers: string[]
  rows: unknown[][]
}

/**
 * One booking per row, with everything the three reports aggregate. The same
 * filter produces the same population as the on-screen report, so an export always
 * reconciles with what the operator was looking at.
 *
 * "Guest total" is what was charged and "Host payout" the raw price the host is
 * owed; Commission is the gap. They add up per row, which is the property that
 * makes the export auditable — the old export wrote the host figure under "Total"
 * and a percentage under "Commission", and those two never summed to anything.
 */
export async function reportRows(f: ReportFilter, dateColumn: DateColumn = 'created_at'): Promise<ReportRows> {
  const w = where(f, dateColumn)
  const { rows } = await pool.query(
    `SELECT b.reservation_code, b.status, b.payment_status,
            to_char(b.created_at, 'YYYY-MM-DD')   AS created,
            to_char(b.check_in,  'YYYY-MM-DD')    AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD')    AS check_out,
            to_char(b.cancelled_at, 'YYYY-MM-DD') AS cancelled,
            b.cancelled_by_role, b.cancellation_policy,
            l.title, ${RESORT_LABEL_SQL} AS resort, l.region,
            hu.email AS host_email, gu.email AS guest_email,
            ${GUEST_SQL}::float8 AS total,
            b.total_price::float8 AS host_payout,
            ${bookingCommissionSql()}::float8 AS commission,
            (${bookingRateSql()} * 100)::float8 AS commission_percent,
            COALESCE(b.refund_percent, 0)::int AS refund_percent,
            (${GUEST_SQL} * COALESCE(b.refund_percent, 0) / 100.0)::float8 AS refund
       ${FROM_SQL}
       LEFT JOIN users hu ON hu.id = l.host_id
       LEFT JOIN users gu ON gu.id = b.user_id
      WHERE ${w.sql}
      ORDER BY b.created_at DESC
      LIMIT 10000`,
    w.params
  )

  const headers = [
    'Reservation', 'Status', 'Payment', 'Created', 'Check in', 'Check out', 'Cancelled',
    'Cancelled by', 'Policy', 'Listing', 'Resort', 'Region', 'Host', 'Guest',
    'Guest total', 'Host payout', 'Commission', 'Commission %', 'Refund %', 'Refund',
  ]
  return {
    headers,
    rows: rows.map((r) => [
      r.reservation_code, r.status, r.payment_status, r.created, r.check_in, r.check_out,
      r.cancelled, r.cancelled_by_role ?? 'unknown', r.cancellation_policy ?? 'unknown',
      r.title, r.resort, r.region, r.host_email, r.guest_email,
      r.total, r.host_payout, r.commission, r.commission_percent, r.refund_percent, r.refund,
    ]),
  }
}

// ---- Facets for the filter bar ----------------------------------------------

export interface ReportFacets {
  regions: string[]
  resorts: Array<{ id: string; name: string; region: string }>
  hosts: Array<{ id: string; email: string; name: string | null }>
}

/** Options for the filter dropdowns. Hosts are limited to those who actually own a
 *  listing, so the list stays short and every option can return rows. */
export async function reportFacets(): Promise<ReportFacets> {
  const [resorts, hosts] = await Promise.all([
    pool.query(`SELECT id, name, region FROM resorts WHERE is_active ORDER BY region, name`),
    pool.query(
      `SELECT DISTINCT u.id, u.email, u.full_name AS name
         FROM users u JOIN listings l ON l.host_id = u.id
        ORDER BY u.email LIMIT 500`
    ),
  ])
  return {
    regions: [...new Set(resorts.rows.map((r) => r.region as string))],
    resorts: resorts.rows as ReportFacets['resorts'],
    hosts: hosts.rows as ReportFacets['hosts'],
  }
}
