// The metric whitelist, range math and series filling behind the /ops Overview's
// card → graph panel.
//
// Pure, and DELIBERATELY free of runtime imports, for the same reason as
// analytics-core.ts: Node's ESM resolver rejects the extension-less relative
// specifiers the rest of src/lib/local uses, so a module with no relative imports
// is the one shape `node --test` can load directly. db.ts imports this; never the
// reverse. Nothing here may touch `pool`. See README → Testing.
//
// ---------------------------------------------------------------------------
// WHY ONLY NINE OF THE TWELVE OVERVIEW CARDS ARE CHARTABLE
//
// A card is a count of rows matching a predicate *right now*. Drawing its history
// needs a timestamp saying when each row started matching. Three cards have no
// such column and so are deliberately absent from METRICS — the tiles stay
// unclickable rather than showing a line that answers a different question:
//
//   Published          listings has no `published_at` (nor `approved_at`).
//   Pending bookings   bookings has created_at / paid_at / cancelled_at — no
//   Confirmed          status-change timestamps at all.
//
// If those are ever wanted, the fix is a nightly `metric_daily` snapshot table,
// not a cleverer query: the information is not in the database today.
// ---------------------------------------------------------------------------

// ---- Ranges -----------------------------------------------------------------

export const RANGE_IDS = ['7d', '30d', '90d', '12mo'] as const
export type RangeId = (typeof RANGE_IDS)[number]

export const DEFAULT_RANGE: RangeId = '30d'

export interface RangeSpec {
  label: string
  /** Bucket count, including the current (still-running) one. */
  buckets: number
  granularity: 'day' | 'month'
}

/** Granularity is fixed per range rather than chosen separately: 90 monthly
 *  buckets and 12 daily ones are both nonsense, and one control beats two. */
export const RANGES: Record<RangeId, RangeSpec> = {
  '7d': { label: '7 days', buckets: 7, granularity: 'day' },
  '30d': { label: '30 days', buckets: 30, granularity: 'day' },
  '90d': { label: '90 days', buckets: 90, granularity: 'day' },
  '12mo': { label: '12 months', buckets: 12, granularity: 'month' },
}

/** Bad user input — the route maps this to HTTP 400, mirroring ReportInputError. */
export class TrendInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrendInputError'
  }
}

export function parseRange(value: string | null | undefined): RangeId {
  const raw = (value ?? '').trim()
  if (!raw) return DEFAULT_RANGE
  if (!(RANGE_IDS as readonly string[]).includes(raw)) {
    throw new TrendInputError(`range must be one of: ${RANGE_IDS.join(', ')}`)
  }
  return raw as RangeId
}

// ---- Metrics ----------------------------------------------------------------

export const METRIC_IDS = [
  'users',
  'hosts',
  'verified',
  'listings',
  'bookings',
  'paid',
  'applications',
  'verifications',
] as const
export type MetricId = (typeof METRIC_IDS)[number]

export interface MetricSpec {
  /** Chart title. Not always the card's label — see `note`. */
  label: string
  /**
   * Whether a running total is meaningful.
   *
   * False for the two queue metrics. Their cards count what is *pending right
   * now*, and nothing records when an item stopped being pending, so a running
   * total would be "submitted ever" — a line that climbs forever and never meets
   * the number on the card. Those chart new-per-period only.
   */
  cumulative: boolean
  /** Shown under the title when the series answers a narrower question than its card. */
  note?: string
  /** FROM clause plus any joins. */
  from: string
  /** Row filter, or null for "every row". */
  where: string | null
  /** The timestamp each row is dated by. Never interpolated from user input. */
  at: string
}

/**
 * The whitelist. `from` / `where` / `at` are the ONLY things interpolated into the
 * trend SQL as identifiers, and they are constants keyed by a MetricId that is
 * itself validated against METRIC_IDS — there is no path from a querystring to a
 * SQL identifier.
 *
 * Every cumulative metric is dated so its final running total equals the matching
 * Overview card exactly. That is why `hosts` and `verified` fall back to
 * `created_at`: an account with no approval or verification timestamp (seeded, or
 * flipped directly in the database) must still be counted once, on some plausible
 * day, or the chart would end below the tile sitting next to it.
 */
export const METRICS: Record<MetricId, MetricSpec> = {
  users: {
    label: 'Users',
    cumulative: true,
    from: 'users u',
    where: null,
    at: 'u.created_at',
  },

  // No `users.host_since` column exists, so a host is dated by the decision that
  // made them one. LEFT JOIN, not INNER: a host granted any other way still counts.
  hosts: {
    label: 'Hosts',
    cumulative: true,
    note: 'Dated by the host application that was approved; hosts created another way count from signup.',
    from: `users u
      LEFT JOIN LATERAL (
        SELECT ha.reviewed_at
          FROM host_applications ha
         WHERE ha.user_id = u.id AND ha.status = 'approved'
         ORDER BY ha.reviewed_at DESC NULLS LAST
         LIMIT 1
      ) hostapp ON true`,
    where: 'COALESCE(u.is_host, false) = true',
    at: 'COALESCE(hostapp.reviewed_at, u.created_at)',
  },

  // users.verification_status is the source of truth, matching adminStats — NOT the
  // id_verifications log, which disagrees the moment someone is verified without a
  // matching submission row.
  verified: {
    label: 'Verified users',
    cumulative: true,
    note: 'Counts who is verified today, dated by when they were verified — a later un-verify removes them from the whole line, not just its end.',
    from: 'users u',
    where: `u.verification_status = 'verified'`,
    at: 'COALESCE(u.verified_at, u.created_at)',
  },

  listings: {
    label: 'Listings',
    cumulative: true,
    from: 'listings l',
    where: null,
    at: 'l.created_at',
  },

  bookings: {
    label: 'Bookings',
    cumulative: true,
    from: 'bookings b',
    where: null,
    at: 'b.created_at',
  },

  // ⚠️ THE paid_at TRAP (analytics-core documents it at length): a refund sets
  // paid_at = NULL, so `paid_at IS NOT NULL` silently drops refunded bookings.
  // What decides "paid" is payment_status; paid_at is only the date axis, and it
  // falls back to created_at so a paid row with no stamp is still plotted once.
  paid: {
    label: 'Paid bookings',
    cumulative: true,
    from: 'bookings b',
    where: `COALESCE(b.payment_status, 'unpaid') = 'paid'`,
    at: 'COALESCE(b.paid_at, b.created_at)',
  },

  applications: {
    label: 'Host applications submitted',
    cumulative: false,
    note: 'How many arrived, not how many were pending — nothing records when an application left the queue.',
    from: 'host_applications ha',
    where: null,
    at: 'ha.submitted_at',
  },

  verifications: {
    label: 'ID verifications submitted',
    cumulative: false,
    note: 'How many arrived, not how many were pending — nothing records when a submission left the queue.',
    from: 'id_verifications v',
    where: null,
    at: 'v.submitted_at',
  },
}

/** A metric as the BROWSER sees it. METRICS also carries the from/where/at SQL, and
 *  a table and column map is not something a page needs in order to draw a line. */
export interface PublicMetric {
  label: string
  cumulative: boolean
  note: string | null
}

/** The whole trend response. Assembled in one place so the API route and the server
 *  component that seeds the page cannot drift into shipping different shapes. */
export interface TrendPayload {
  range: RangeId
  granularity: 'day' | 'month'
  series: Record<MetricId, SeriesPoint[]>
  metrics: Record<MetricId, PublicMetric>
}

/** METRICS with the SQL stripped off. The client renders titles, notes and the
 *  cumulative/new toggle from this, so the wording and the "can this be a running
 *  total?" rule stay next to the SQL that makes the claim true. */
export function publicMetrics(): Record<MetricId, PublicMetric> {
  const out = {} as Record<MetricId, PublicMetric>
  for (const id of METRIC_IDS) {
    const m = METRICS[id]
    out[id] = { label: m.label, cumulative: m.cumulative, note: m.note ?? null }
  }
  return out
}

export function parseMetric(value: string | null | undefined): MetricId {
  const raw = (value ?? '').trim()
  if (!raw) return 'users'
  if (!(METRIC_IDS as readonly string[]).includes(raw)) {
    throw new TrendInputError(`metric must be one of: ${METRIC_IDS.join(', ')}`)
  }
  return raw as MetricId
}

// ---- Bucket math ------------------------------------------------------------
//
// Buckets are built HERE rather than by generate_series so the dense axis is a
// pure function that can be tested without a database — and so a bucket with no
// rows is a zero on the chart instead of a missing point. A sparse cumulative
// series is not merely ugly: joining across a gap draws a straight line through
// days that did not happen.

const DAY_MS = 86_400_000

/** 'YYYY-MM-DD' for a Date, in UTC. Everything here is date-bucketed, not
 *  time-of-day sensitive, so UTC throughout beats a half-applied local timezone —
 *  the same call analytics-core makes. */
export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * The dense bucket list a range covers, oldest first, each the bucket's first day
 * as 'YYYY-MM-DD'. The last entry is always the bucket `now` falls in, so the
 * newest point is the current (partial) day or month.
 */
export function bucketsFor(range: RangeId, now: Date): string[] {
  const spec = RANGES[range]
  if (!spec) throw new TrendInputError(`Unknown range: ${range}`)
  const out: string[] = []

  if (spec.granularity === 'month') {
    const y = now.getUTCFullYear()
    const m = now.getUTCMonth()
    for (let i = spec.buckets - 1; i >= 0; i--) {
      out.push(toDateString(new Date(Date.UTC(y, m - i, 1))))
    }
    return out
  }

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  for (let i = spec.buckets - 1; i >= 0; i--) {
    out.push(toDateString(new Date(today - i * DAY_MS)))
  }
  return out
}

/**
 * The half-open window the SQL scans: `at >= from AND at < toExclusive`.
 * `from` doubles as the cutoff for the baseline count (`at < from`).
 */
export function windowFor(range: RangeId, now: Date): { from: string; toExclusive: string } {
  const buckets = bucketsFor(range, now)
  const from = buckets[0]
  const last = buckets[buckets.length - 1]
  const d = new Date(`${last}T00:00:00Z`)
  const end =
    RANGES[range].granularity === 'month'
      ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
      : new Date(d.getTime() + DAY_MS)
  return { from, toExclusive: toDateString(end) }
}

// ---- Series -----------------------------------------------------------------

export interface SeriesPoint {
  /** Bucket start, 'YYYY-MM-DD'. */
  bucket: string
  /** Rows dated inside this bucket. */
  count: number
  /** Running total including this bucket, or null when a total is meaningless. */
  total: number | null
}

/**
 * Turn the sparse `GROUP BY bucket` rows into the dense series the chart draws.
 *
 * `baseline` is how many rows fall strictly BEFORE the first bucket. Without it a
 * running total would restart from zero at the left edge of every range — the
 * 7-day view would claim the platform has seven days' worth of users, and the
 * final point would never match the card it was opened from.
 *
 * Rows whose bucket is not on the axis (possible only if the clock moved between
 * building the axis and running the query) are ignored rather than appended out
 * of order.
 */
export function buildSeries(
  buckets: string[],
  rows: Array<{ bucket: string; count: number | string }>,
  baseline: number,
  cumulative: boolean,
): SeriesPoint[] {
  const byBucket = new Map<string, number>()
  for (const r of rows) {
    const n = Number(r.count) || 0
    byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + n)
  }

  let running = Number(baseline) || 0
  return buckets.map((bucket) => {
    const count = byBucket.get(bucket) ?? 0
    running += count
    return { bucket, count, total: cumulative ? running : null }
  })
}

/** Net change across the series — what the "+37 in 30 days" caption reports.
 *  Sums the per-bucket counts, so it is right in both modes. */
export function seriesDelta(points: SeriesPoint[]): number {
  return points.reduce((n, p) => n + p.count, 0)
}
