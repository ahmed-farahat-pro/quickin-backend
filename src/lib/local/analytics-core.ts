// Report filtering, SQL fragments and money math for the /ops analytics screens
// (B1 bookings, B2 payments, B3 cancellations).
//
// Pure, and DELIBERATELY free of runtime imports — Node's ESM resolver rejects the
// extension-less relative specifiers the rest of src/lib/local uses, so a module
// with no relative imports is the one shape `node --test` can load directly.
// analytics.ts imports this; never the reverse. Nothing here may touch `pool`.
// See README → Testing.

// ---- Filter contract --------------------------------------------------------

/** Resort filter sentinels. A listing has EITHER a catalog resort or free text, so
 *  these two cover the rows no resort id can address. */
export const OTHER_RESORT_KEY = '__other__' // host typed a name; not yet in the catalog
export const NO_RESORT_KEY = '__none__' // no resort at all

export const GRANULARITIES = ['day', 'week', 'month'] as const
export type Granularity = (typeof GRANULARITIES)[number]

/** Date axes a report may bucket/filter on. This list is the ONLY thing ever
 *  interpolated into SQL as an identifier — everything else is a $n placeholder.
 *  `money_at` is virtual: it maps to MONEY_AT_SQL, not a real column. */
export const DATE_COLUMNS = ['created_at', 'paid_at', 'cancelled_at', 'check_in', 'money_at'] as const
export type DateColumn = (typeof DATE_COLUMNS)[number]

/** Default window when the caller supplies no dates. 90 days is long enough to
 *  show a trend and short enough to stay fast on an unindexed-ish table. */
export const DEFAULT_RANGE_DAYS = 90

export interface ReportFilter {
  /** 'YYYY-MM-DD', inclusive. Always resolved — never null. */
  from: string
  /** 'YYYY-MM-DD', inclusive. The SQL widens this to `< to + 1 day` so a
   *  timestamptz column includes the whole final day. */
  to: string
  region: string | null
  /** A resorts.id, or OTHER_RESORT_KEY / NO_RESORT_KEY. */
  resort: string | null
  hostId: string | null
  listingId: string | null
  granularity: Granularity
}

/** Bad user input — the route maps this to HTTP 400, mirroring ListingInputError. */
export class ReportInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportInputError'
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-fA-F-]{36}$/

/** 'YYYY-MM-DD' for a Date, in UTC. Reports are date-bucketed, not time-of-day
 *  sensitive, so UTC everywhere beats a half-applied local timezone. */
export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function requireDate(value: string, label: string): string {
  if (!DATE_RE.test(value)) throw new ReportInputError(`${label} must be YYYY-MM-DD`)
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) throw new ReportInputError(`${label} is not a real date`)
  return value
}

/**
 * Turn a querystring into a validated filter.
 *
 * `get` is `URLSearchParams.get` (or anything with that shape), so this is
 * testable without constructing a Request. `now` is injectable for the same
 * reason — the 90-day default would otherwise be untestable.
 *
 * `allowedRegions` is passed in rather than imported, because importing
 * REGION_VALUES from resort-core.ts would add the relative import this module
 * exists to avoid. Omit it to skip region validation (values are always
 * parameterised, so an unknown region is a wrong answer, never an injection).
 */
export function parseReportFilter(
  get: (key: string) => string | null,
  opts: { allowedRegions?: readonly string[]; now?: Date } = {}
): ReportFilter {
  const now = opts.now ?? new Date()

  const rawTo = get('to')
  const rawFrom = get('from')
  const to = rawTo ? requireDate(rawTo, 'to') : toDateString(now)
  const from = rawFrom
    ? requireDate(rawFrom, 'from')
    : toDateString(new Date(new Date(`${to}T00:00:00Z`).getTime() - DEFAULT_RANGE_DAYS * 86_400_000))

  if (from > to) throw new ReportInputError('from must not be after to')

  const region = get('region')?.trim() || null
  if (region && opts.allowedRegions && !opts.allowedRegions.includes(region)) {
    throw new ReportInputError(`Unknown region: ${region}`)
  }

  const resort = get('resort')?.trim() || null
  if (resort && resort !== OTHER_RESORT_KEY && resort !== NO_RESORT_KEY && !UUID_RE.test(resort)) {
    throw new ReportInputError('resort must be a resort id, __other__ or __none__')
  }

  const hostId = get('host')?.trim() || null
  if (hostId && !UUID_RE.test(hostId)) throw new ReportInputError('host must be a uuid')

  const listingId = get('listing')?.trim() || null
  if (listingId && !UUID_RE.test(listingId)) throw new ReportInputError('listing must be a uuid')

  const rawGran = get('granularity')?.trim() || 'day'
  if (!(GRANULARITIES as readonly string[]).includes(rawGran)) {
    throw new ReportInputError(`granularity must be one of: ${GRANULARITIES.join(', ')}`)
  }

  return { from, to, region, resort, hostId, listingId, granularity: rawGran as Granularity }
}

// ---- SQL fragments ----------------------------------------------------------
// Every query in analytics.ts builds on these, so a predicate is defined once and
// cannot be re-derived subtly differently in the next report.

/** Reports always read bookings b JOIN listings l, then optionally the resort. */
export const RESORT_JOIN = `LEFT JOIN resorts r ON r.id = l.resort_id`

/** Group key: a resort id, or one of the two sentinels. */
export const RESORT_KEY_SQL = `COALESCE(r.id::text, CASE WHEN l.resort_name IS NOT NULL THEN '${OTHER_RESORT_KEY}' ELSE '${NO_RESORT_KEY}' END)`

/** Human label for the same. Free-text listings collapse into one "Others" row —
 *  the per-name detail lives in the /ops resorts queue, not in a revenue report. */
export const RESORT_LABEL_SQL = `COALESCE(r.name, CASE WHEN l.resort_name IS NOT NULL THEN 'Others' ELSE 'Unassigned' END)`

// ⚠️ THE paid_at TRAP.
// setBookingPaymentOutcome() sets paid_at = NULL when a booking is refunded or
// voided. So `paid_at IS NOT NULL` SILENTLY DROPS every refunded booking —
// adminStats had exactly that bug. Use these constants, never a hand-written
// predicate, and never bucket money by paid_at alone.
export const PAID_SQL = `COALESCE(b.payment_status, 'unpaid') = 'paid'`
export const REFUNDED_SQL = `COALESCE(b.payment_status, 'unpaid') IN ('refunded', 'voided')`
/** The money date axis that survives a refund clearing paid_at. */
export const MONEY_AT_SQL = `COALESCE(b.paid_at, b.refunded_at, b.cancelled_at, b.created_at)`

/** B1 "active" is not a status — there is no 'active' in BOOKING_STATUSES. It means
 *  a confirmed booking whose stay has not ended. Named so the UI and SQL agree. */
export const ACTIVE_SQL = `b.status = 'confirmed' AND b.check_out >= CURRENT_DATE`

const DATE_EXPR: Record<DateColumn, string> = {
  created_at: 'b.created_at',
  paid_at: 'b.paid_at',
  cancelled_at: 'b.cancelled_at',
  check_in: 'b.check_in',
  money_at: MONEY_AT_SQL,
}

/** Resolve a whitelisted date axis to its SQL expression. Throws on anything else —
 *  this is the guard that keeps identifier interpolation safe. */
export function dateExpr(column: DateColumn): string {
  const expr = DATE_EXPR[column]
  if (!expr) throw new ReportInputError(`Unknown date column: ${column}`)
  return expr
}

/**
 * The ONE place a filter becomes SQL.
 *
 * `offset` is how many $params the caller has already pushed, so the fragment can
 * be spliced into a larger query. Returns clauses to AND together plus the params
 * to append, in order.
 *
 * Security: the only interpolated identifier is the date expression, resolved via
 * the DATE_COLUMNS whitelist. Every value is a $n placeholder.
 */
export function buildReportWhere(
  f: ReportFilter,
  dateColumn: DateColumn,
  offset = 0
): { clauses: string[]; params: unknown[] } {
  const expr = dateExpr(dateColumn)
  const clauses: string[] = []
  const params: unknown[] = []
  const next = () => `$${offset + params.length + 1}`

  // Inclusive of the whole `to` day: check_in is a date, the rest are timestamptz.
  clauses.push(`${expr} >= ${next()}::date`)
  params.push(f.from)
  clauses.push(`${expr} < (${next()}::date + interval '1 day')`)
  params.push(f.to)

  if (f.region) {
    clauses.push(`l.region = ${next()}`)
    params.push(f.region)
  }

  if (f.resort === OTHER_RESORT_KEY) {
    clauses.push(`l.resort_id IS NULL AND l.resort_name IS NOT NULL`)
  } else if (f.resort === NO_RESORT_KEY) {
    clauses.push(`l.resort_id IS NULL AND l.resort_name IS NULL`)
  } else if (f.resort) {
    clauses.push(`l.resort_id = ${next()}::uuid`)
    params.push(f.resort)
  }

  if (f.hostId) {
    clauses.push(`l.host_id = ${next()}::uuid`)
    params.push(f.hostId)
  }

  if (f.listingId) {
    clauses.push(`b.listing_id = ${next()}::uuid`)
    params.push(f.listingId)
  }

  return { clauses, params }
}

/** Bucket expression for a trend series. `expr` must already be safe (it comes
 *  from dateExpr). */
export function bucketSql(granularity: Granularity, expr: string): string {
  if (!(GRANULARITIES as readonly string[]).includes(granularity)) {
    throw new ReportInputError(`Unknown granularity: ${granularity}`)
  }
  return `date_trunc('${granularity}', ${expr})`
}

// ---- Money ------------------------------------------------------------------
//
// THE COMMISSION MATH IS NOT HERE. It lives in commission-core.ts —
// commissionAmount(), withCommission(), bookingCommissionSql() — because the
// markup has to round identically in TypeScript and in SQL, and because that file
// is byte-parity-guarded against the backend's copy. Reach for it, not for a
// percentage of total_price.
//
// This module used to carry commissionFor()/hostNetFor(), written for the OLD fee
// model: commission = total × rate, host net = total − commission. Both are wrong
// now — the commission is a markup ADDED to the host's price, and the host is paid
// that price in full. They had no callers outside their own tests, so they are gone
// rather than corrected; a second, subtly different definition of the platform's
// margin is exactly the drift commission-core exists to prevent.
//
// refundFor() stays: a refund is a percentage of a charge, which is true under any
// model. Pass it the GUEST figure, since that is what was actually collected.

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Refund value. NEVER read bookings.refund_amount — the web cancel path writes
 * refund_percent only, leaving refund_amount NULL, so it is wrong for roughly
 * half the rows. Always recompute from the percentage.
 */
export function refundFor(total: number, refundPercent: number | null | undefined): number {
  const pct = refundPercent === null || refundPercent === undefined ? 0 : Number(refundPercent) || 0
  const clamped = Math.min(100, Math.max(0, pct))
  return round2(((Number(total) || 0) * clamped) / 100)
}

// ---- CSV --------------------------------------------------------------------

/**
 * One RFC-4180 cell.
 *
 * Two non-obvious rules:
 *  - A leading `= + - @` is prefixed with a single quote. Excel and Sheets treat
 *    those as formulas, so a listing titled `=cmd|...` is a spreadsheet injection
 *    vector against whoever opens the export.
 *  - Leading/trailing spaces force quoting, otherwise they are silently eaten.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = typeof value === 'string' ? value : String(value)
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  const mustQuote = /["\r\n,]/.test(s) || s !== s.trim()
  return mustQuote ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Rows → CSV text. CRLF terminators per RFC-4180.
 *
 * `withBom` prefixes a UTF-8 BOM, which is what makes Excel on Windows read
 * Arabic listing names correctly instead of as mojibake. Default on, because the
 * only consumer is a download.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  { withBom = true }: { withBom?: boolean } = {}
): string {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))]
  return (withBom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n'
}
