// Per-date nightly pricing — the host calendar's data rules.
//
// MODEL: a host may pin an exact nightly rate to an exact calendar day. That pin
// sits at the TOP of the pricing ladder and beats every other rule:
//
//     custom date price  →  weekend rate  →  that month's rate  →  base price
//
// "Reset to default" is a DELETE, not a write of the base price. A pinned day
// that merely happened to equal the base would silently stop tracking the base
// when the host later edited it, so the absence of a row is the only honest way
// to say "this day has no opinion of its own".
//
// A day's price is the price of the NIGHT that starts on it. A stay
// [check_in, check_out) is charged for the nights check_in … check_out-1, so the
// checkout day is never priced. Every date here is a plain 'YYYY-MM-DD' string
// in the listing's local sense — no timezone, no Date objects — because a night
// belongs to a calendar day, not to an instant.
//
// No runtime imports, so `node --test` can import this file directly — see
// CLAUDE.md → "Standing requirement — docs and tests". db.ts imports this
// module; this module never imports db.ts.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// read the same Neon table. scripts/check-date-pricing-core-parity.mjs fails if
// they drift, so edit one copy and paste it over the other verbatim.

/** The table a pinned nightly price lives in. One row per (listing, date). */
export const DATE_PRICES_TABLE = 'listing_date_prices'

/** How far ahead a host may price. Two years of calendar is already more than
 *  any host plans; the cap exists so a fat-fingered year can't write 3000 rows. */
export const MAX_MONTHS_AHEAD = 24

/** Most days one request may touch. A whole two-year window is ~730 days, so
 *  this comfortably allows "select everything visible" while refusing a script. */
export const MAX_DATES_PER_REQUEST = 800

/** A nightly rate a host types is money, in whole-ish EGP. The ceiling is a
 *  typo guard (a missed decimal point), not a business rule. */
export const MIN_NIGHTLY_PRICE = 1
export const MAX_NIGHTLY_PRICE = 10_000_000

/** Egypt's weekend. Used when a caller has no per-listing weekend_days. */
export const DEFAULT_WEEKEND_DAYS: readonly number[] = [5, 6]

/** Where a night's price came from. Drives the calendar's badge and the
 *  booking summary's "custom price" marker. */
export type PriceSource = 'custom' | 'weekend' | 'monthly' | 'base'

/** Whether a host may touch a given day. `booked` days are priced by the
 *  reservation that took them and must not be re-rated underneath a guest. */
export type DayStatus = 'available' | 'blocked' | 'booked'

/** Thrown for host input a human should fix; routes map it to HTTP 400. */
export class DatePriceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatePriceError'
  }
}

/** Cross-realm-safe check (routes may see an error thrown in another bundle). */
export function isDatePriceError(e: unknown): e is DatePriceError {
  return e instanceof Error && e.name === 'DatePriceError'
}

// ---- Dates -------------------------------------------------------------------

/** Strict 'YYYY-MM-DD', and a real day: '2026-02-30' and '2026-13-01' are not.
 *  A regex alone accepts both, and Postgres would reject them at the far end of
 *  a 400-date insert — after we had already told the host it worked. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
  // Date.UTC normalises overflow (Feb 30 → Mar 2), so a round trip that changes
  // any component means the day does not exist.
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** 'YYYY-MM-DD' for a UTC-midnight timestamp. */
function isoFromUtc(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** UTC-midnight timestamp for a validated 'YYYY-MM-DD'. */
function utcFromIso(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
}

const DAY_MS = 86_400_000

/** `date` shifted by whole days, still 'YYYY-MM-DD'. */
export function addDays(date: string, days: number): string {
  if (!isIsoDate(date)) throw new DatePriceError(`Invalid date: ${String(date)}`)
  return isoFromUtc(utcFromIso(date) + days * DAY_MS)
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new DatePriceError('Invalid date range')
  return Math.round((utcFromIso(to) - utcFromIso(from)) / DAY_MS)
}

/** Day of week, 0=Sun … 6=Sat — the same numbering Postgres `extract(dow)` uses,
 *  so the SQL ladder and the TypeScript ladder agree about which day it is. */
export function dayOfWeek(date: string): number {
  if (!isIsoDate(date)) throw new DatePriceError(`Invalid date: ${String(date)}`)
  return new Date(utcFromIso(date)).getUTCDay()
}

/** Month 1..12 — the key `monthly_prices` is indexed by. */
export function monthOf(date: string): number {
  if (!isIsoDate(date)) throw new DatePriceError(`Invalid date: ${String(date)}`)
  return Number(date.slice(5, 7))
}

/** INCLUSIVE list of days from `start` to `end` — a calendar span the host
 *  dragged over, where both ends are days they selected and expect to price.
 *  This is deliberately NOT the half-open [check_in, check_out) of a stay. */
export function expandRange(start: string, end: string): string[] {
  if (!isIsoDate(start) || !isIsoDate(end)) throw new DatePriceError('Invalid date range')
  if (end < start) throw new DatePriceError('Range end must not be before its start')
  const n = daysBetween(start, end)
  if (n + 1 > MAX_DATES_PER_REQUEST) {
    throw new DatePriceError(`That range covers ${n + 1} days; the limit is ${MAX_DATES_PER_REQUEST}`)
  }
  const out: string[] = []
  for (let i = 0; i <= n; i++) out.push(addDays(start, i))
  return out
}

/** The nights a stay is charged for: [checkIn, checkOut), so the checkout day is
 *  excluded. Returns [] for a zero-or-negative-length stay rather than throwing,
 *  because a half-filled date picker is a normal UI state, not an error. */
export function nightsOfStay(checkIn: string, checkOut: string): string[] {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return []
  const n = daysBetween(checkIn, checkOut)
  if (n <= 0) return []
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(addDays(checkIn, i))
  return out
}

/**
 * Clean what a client sent as "the days I selected": accepts an array of
 * 'YYYY-MM-DD' strings and/or `{start,end}` spans, and answers a sorted,
 * de-duplicated list. THROWS on anything unusable — a silently dropped date is
 * a day the host believes they priced and did not.
 */
export function normalizeDates(input: unknown): string[] {
  if (!Array.isArray(input)) throw new DatePriceError('Select at least one date')
  const seen = new Set<string>()
  for (const entry of input) {
    if (typeof entry === 'string') {
      if (!isIsoDate(entry)) throw new DatePriceError(`Invalid date: ${entry}`)
      seen.add(entry)
      continue
    }
    if (entry && typeof entry === 'object') {
      const span = entry as { start?: unknown; end?: unknown }
      if (typeof span.start === 'string' && typeof span.end === 'string') {
        for (const d of expandRange(span.start, span.end)) seen.add(d)
        continue
      }
    }
    throw new DatePriceError('Each date must be "YYYY-MM-DD" or {start,end}')
  }
  if (seen.size === 0) throw new DatePriceError('Select at least one date')
  if (seen.size > MAX_DATES_PER_REQUEST) {
    throw new DatePriceError(`${seen.size} dates selected; the limit is ${MAX_DATES_PER_REQUEST}`)
  }
  return [...seen].sort()
}

/**
 * Refuse days outside the window a host may price: nothing in the past, nothing
 * beyond MAX_MONTHS_AHEAD. `today` is passed in rather than read from the clock
 * so the rule is testable and so the caller decides which day "today" is.
 */
export function assertWithinWindow(dates: readonly string[], today: string): void {
  if (!isIsoDate(today)) throw new DatePriceError('Invalid current date')
  const horizon = addDays(today, Math.round(MAX_MONTHS_AHEAD * 30.44))
  for (const d of dates) {
    if (d < today) throw new DatePriceError(`${d} is in the past`)
    if (d > horizon) throw new DatePriceError(`${d} is more than ${MAX_MONTHS_AHEAD} months away`)
  }
}

// ---- The price a host typed --------------------------------------------------

/** How a typed nightly price can fail. Clients switch on this, not on text. */
export type DayPriceProblem =
  /** Not a number at all — 'abc', '1,500', '--'. */
  | 'notANumber'
  /** A number, but not money — 0, -200. */
  | 'notPositive'
  /** Above MAX_NIGHTLY_PRICE — almost always a missed decimal point. */
  | 'tooLarge'

export type DayPriceResult =
  /** `null` = "reset these days to the default", i.e. delete their rows. */
  | { ok: true; value: number | null }
  | { ok: false; problem: DayPriceProblem }

/**
 * Validate what the host typed for a day's rate.
 *
 * Empty means RESET, not zero: `undefined`, `null`, `''` and a blank string all
 * answer `{ ok: true, value: null }`, which the caller turns into a delete. A
 * typed `0` is refused instead of being treated as "clear it" — 0 is either a
 * typo or a misreading of the field, and a listing that silently became free
 * would be discovered by its first booking. (Same rule, same reasoning, as
 * checkWeekendPrice.)
 */
export function checkDayPrice(input: unknown): DayPriceResult {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (typeof input === 'string' && input.trim() === '') return { ok: true, value: null }
  // Number(true) is 1 and Number([]) is 0 — neither is a price a host typed.
  if (typeof input !== 'number' && typeof input !== 'string') return { ok: false, problem: 'notANumber' }
  const n = Number(input)
  if (!Number.isFinite(n)) return { ok: false, problem: 'notANumber' }
  if (n < MIN_NIGHTLY_PRICE) return { ok: false, problem: 'notPositive' }
  if (n > MAX_NIGHTLY_PRICE) return { ok: false, problem: 'tooLarge' }
  // Piaster precision, matching numeric(12,2) in the table.
  return { ok: true, value: Math.round(n * 100) / 100 }
}

/** English message for a rejected day price — what the API answers with. */
export function dayPriceMessage(problem: DayPriceProblem): string {
  if (problem === 'notPositive') return `Nightly price must be at least ${MIN_NIGHTLY_PRICE} EGP`
  if (problem === 'tooLarge') return `Nightly price must be ${MAX_NIGHTLY_PRICE.toLocaleString('en-US')} EGP or less`
  return 'Nightly price must be a number'
}

// ---- The ladder --------------------------------------------------------------

/** Everything the ladder needs to price one night. `weekendDays`/`monthlyPrices`
 *  are optional because the two projects don't (yet) run identical ladders — see
 *  README → "Known divergence: web vs backend stay totals". Omitting a rung
 *  simply skips it. */
export interface PricingRules {
  /** listings.price_per_night — the only rung that is never absent. */
  basePrice: number
  /** listings.weekend_price, or null/undefined for "no weekend rate". */
  weekendPrice?: number | null
  /** listings.weekend_days (0=Sun … 6=Sat). Defaults to Fri+Sat. */
  weekendDays?: readonly number[] | null
  /** listings.monthly_prices — { "1".."12": nightly }. */
  monthlyPrices?: Record<string, unknown> | null
  /** listing_date_prices, as { 'YYYY-MM-DD': nightly }. Beats everything. */
  datePrices?: Record<string, unknown> | null
}

/** One priced night. */
export interface NightPrice {
  date: string
  price: number
  source: PriceSource
}

/** Only finite, positive numbers are prices; everything else is absent. A junk
 *  row must fall through to the next rung rather than price a night at NaN. */
function money(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The host's RAW price for one night, and which rung produced it.
 *
 * This is the TypeScript twin of PER_NIGHT_RAW_SQL in db.ts. Both must answer
 * the same number for the same day, or a client's preview and the server's
 * charge would disagree.
 */
export function resolveNightPrice(date: string, rules: PricingRules): NightPrice {
  const custom = money(rules.datePrices?.[date])
  if (custom !== null) return { date, price: custom, source: 'custom' }

  const weekend = money(rules.weekendPrice)
  if (weekend !== null) {
    const days = rules.weekendDays && rules.weekendDays.length > 0 ? rules.weekendDays : DEFAULT_WEEKEND_DAYS
    if (days.includes(dayOfWeek(date))) return { date, price: weekend, source: 'weekend' }
  }

  const monthly = money(rules.monthlyPrices?.[String(monthOf(date))])
  if (monthly !== null) return { date, price: monthly, source: 'monthly' }

  return { date, price: Math.max(0, Number(rules.basePrice) || 0), source: 'base' }
}

/** Every night of a stay, priced. Empty for an incomplete date selection. */
export function priceNights(checkIn: string, checkOut: string, rules: PricingRules): NightPrice[] {
  return nightsOfStay(checkIn, checkOut).map((d) => resolveNightPrice(d, rules))
}

/** Raw stay subtotal — the sum of the nights, before any length-of-stay discount
 *  and before the platform markup. */
export function stayNightsTotal(nights: readonly NightPrice[]): number {
  return nights.reduce((sum, n) => sum + n.price, 0)
}

/** True when at least one night was pinned by the host's calendar — what the
 *  booking summary uses to decide whether to itemise the nights. */
export function hasCustomNights(nights: readonly NightPrice[]): boolean {
  return nights.some((n) => n.source === 'custom')
}

/** Rows from listing_date_prices → the map `PricingRules.datePrices` wants. */
export function datePriceMap(
  rows: readonly { date: string; price: number | string }[] | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!rows) return out
  for (const row of rows) {
    const n = money(row?.price)
    if (n !== null && isIsoDate(row.date)) out[row.date] = n
  }
  return out
}

// ---- SQL ---------------------------------------------------------------------
// The date rung also has to run inside Postgres, because the authoritative stay
// total is summed there (createBooking, getStayQuote). One definition, so the
// SQL and the TypeScript above cannot disagree about precedence.

/**
 * Scalar subquery: the host's pinned RAW price for the day `dateExpr`, or NULL.
 *
 * `dateExpr` is whatever the surrounding query calls its generate_series day —
 * the two projects use different aliases — and `listingExpr` is the listing id
 * in scope. Both are SQL fragments the caller controls, never user input.
 */
export function dateOverrideSql(dateExpr: string, listingExpr = 'l.id'): string {
  return `(SELECT dp.price FROM ${DATE_PRICES_TABLE} dp
            WHERE dp.listing_id = ${listingExpr} AND dp.date = (${dateExpr})::date)`
}

/**
 * Put the date rung on TOP of an existing per-night ladder. Wrap a project's
 * current CASE expression in this and its stay totals start honouring the
 * calendar without either project having to agree about the rungs below.
 */
export function sqlWithDatePrice(dateExpr: string, fallbackSql: string, listingExpr = 'l.id'): string {
  return `COALESCE(${dateOverrideSql(dateExpr, listingExpr)}, (${fallbackSql}))`
}

// ---- Blocked-day spans -------------------------------------------------------
// The calendar is day-level ("close these four days"), but availability is stored
// as half-open [start_date, end_date) RANGES in listing_blocked_dates, because
// that is what the existing range picker and both mobile apps already write.
//
// Rather than teach every caller to split a range down the middle, these helpers
// round-trip: explode the spans that overlap what the host touched into days,
// apply the change, and re-merge. Notes ride along per day, and only days sharing
// a note re-merge into one span — so unblocking the middle of "maintenance"
// leaves two "maintenance" spans rather than two unlabelled ones.

/** A half-open [start, end) span of unavailable days, as stored. */
export interface BlockSpan {
  /** Present for a span that came from the database; absent for a new one. */
  id?: string
  /** First blocked day, 'YYYY-MM-DD'. */
  start: string
  /** First day that is NOT blocked — exclusive, so a one-day block is start+1. */
  end: string
  /** The host's reason, carried through splits and merges. */
  note?: string | null
}

/** Notes are compared to decide what may merge; null and '' are the same thing. */
function noteKey(note: string | null | undefined): string {
  return typeof note === 'string' && note.trim() !== '' ? note.trim() : ''
}

/**
 * Explode spans into `day → note`. Later spans win a contested day, which only
 * matters for overlapping blocks — a state the range API never prevented.
 */
export function expandBlocks(spans: readonly BlockSpan[]): Map<string, string> {
  const days = new Map<string, string>()
  for (const span of spans) {
    if (!isIsoDate(span?.start) || !isIsoDate(span?.end)) continue
    const n = daysBetween(span.start, span.end)
    // Guard a corrupt row: a span longer than the pricing horizon is not a block
    // a host set, and exploding it would allocate unboundedly.
    if (n <= 0 || n > MAX_DATES_PER_REQUEST * 4) continue
    for (let i = 0; i < n; i++) days.set(addDays(span.start, i), noteKey(span.note))
  }
  return days
}

/**
 * Re-merge `day → note` into the fewest half-open spans. Days merge only when
 * they are consecutive AND carry the same note. Output is sorted by start.
 */
export function mergeBlockedDays(days: ReadonlyMap<string, string>): BlockSpan[] {
  const sorted = [...days.keys()].filter(isIsoDate).sort()
  const out: BlockSpan[] = []
  for (const day of sorted) {
    const note = noteKey(days.get(day))
    const last = out[out.length - 1]
    if (last && last.end === day && noteKey(last.note) === note) {
      last.end = addDays(day, 1)
      continue
    }
    out.push({ start: day, end: addDays(day, 1), note: note === '' ? null : note })
  }
  return out
}

/**
 * The spans that should replace `spans` after the host blocked or unblocked
 * `dates`. Pure — the caller decides which rows to delete and insert.
 *
 * Blocking a day that is already blocked keeps its EXISTING note rather than
 * overwriting it with the new one: the host is confirming a state, not
 * relabelling a block they may not have been looking at.
 */
export function applyBlockChange(
  spans: readonly BlockSpan[],
  dates: readonly string[],
  blocked: boolean,
  note: string | null = null
): BlockSpan[] {
  const days = expandBlocks(spans)
  for (const date of dates) {
    if (!isIsoDate(date)) continue
    if (blocked) {
      if (!days.has(date)) days.set(date, noteKey(note))
    } else {
      days.delete(date)
    }
  }
  return mergeBlockedDays(days)
}

/**
 * The window a block rewrite has to cover: the days the host touched, widened to
 * swallow whole any stored span that overlaps them. Without the widening, a
 * five-day span clipped by a one-day unblock would be rewritten as one day and
 * the other four would silently open up.
 *
 * Returns an INCLUSIVE [from, to] day pair, or null when there is nothing to do.
 */
export function blockRewriteWindow(
  spans: readonly BlockSpan[],
  dates: readonly string[]
): { from: string; to: string } | null {
  const touched = dates.filter(isIsoDate).sort()
  if (touched.length === 0) return null
  let from = touched[0]
  let to = touched[touched.length - 1]
  for (const span of spans) {
    if (!isIsoDate(span?.start) || !isIsoDate(span?.end)) continue
    const lastDay = addDays(span.end, -1)
    // Overlap test against the touched window, both ends inclusive.
    if (lastDay < from || span.start > to) continue
    if (span.start < from) from = span.start
    if (lastDay > to) to = lastDay
  }
  return { from, to }
}

// ---- Calendar grid + selection ----------------------------------------------
// The host calendar's LAYOUT and SELECTION maths, as opposed to its pricing.
// Kept here rather than beside the React component so it can be tested without
// a DOM, and so the iOS and Android calendars have one written definition of
// what a sweep means and where the 1st of a month sits in its week.

/** A sweep either only adds days or only removes them. Decided once, when the
 *  press starts, so dragging back and forth over a day doesn't flip it. */
export type SweepMode = 'add' | 'remove'

/**
 * Which way a sweep starting on `anchor` should go: pressing a day that is
 * already selected removes, pressing an unselected one adds.
 */
export function sweepMode(selected: ReadonlySet<string>, anchor: string): SweepMode {
  return selected.has(anchor) ? 'remove' : 'add'
}

/**
 * Fold a finished sweep into the committed selection. Returns a NEW set — the
 * component holds the selection in state, and mutating it in place would not
 * re-render.
 */
export function applySweep(
  selected: ReadonlySet<string>,
  sweep: Iterable<string>,
  mode: SweepMode
): Set<string> {
  const next = new Set(selected)
  for (const date of sweep) {
    if (mode === 'add') next.add(date)
    else next.delete(date)
  }
  return next
}

/**
 * "Select month" is a TOGGLE: pressing it on a month whose selectable days are
 * all already selected clears them instead of doing nothing. Without that, a
 * host who hit it by accident has to drag the whole month back off by hand.
 *
 * `days` is the month's selectable days — the caller has already dropped the
 * past and the booked ones, since only it knows those.
 */
export function toggleMonthSelection(
  selected: ReadonlySet<string>,
  days: readonly string[]
): Set<string> {
  if (days.length === 0) return new Set(selected)
  const allIn = days.every((d) => selected.has(d))
  return applySweep(selected, days, allIn ? 'remove' : 'add')
}

/** 'YYYY-MM-01' for the month `offset` months after the month of `from`. */
export function monthStart(from: string, offset: number): string {
  if (!isIsoDate(from)) throw new Error(`monthStart: invalid date ${String(from)}`)
  const y = Number(from.slice(0, 4))
  // Month index from year 0, so the arithmetic carries across December without
  // a special case — and floor() keeps a negative offset correct too.
  const m = Number(from.slice(5, 7)) - 1 + offset
  const year = y + Math.floor(m / 12)
  const month = ((m % 12) + 12) % 12
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`
}

/**
 * One month laid out as a Sunday-first grid: `null` for the blank cells before
 * the 1st, then every day of the month.
 *
 * Sunday-first matches dayOfWeek()/Postgres `extract(dow)`, so the column a day
 * lands in is the same number the weekend rule tests.
 */
export function monthGrid(first: string): (string | null)[] {
  if (!isIsoDate(first)) throw new Error(`monthGrid: invalid date ${String(first)}`)
  const year = Number(first.slice(0, 4))
  const month = Number(first.slice(5, 7))
  // Day 0 of the NEXT month is the last day of this one — how many days it has,
  // leap years included, without a lookup table.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const leading = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const cells: (string | null)[] = Array.from({ length: leading }, () => null)
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${first.slice(0, 7)}-${String(d).padStart(2, '0')}`)
  }
  return cells
}

/** Just the days of a month, without the leading blanks. */
export function monthDays(first: string): string[] {
  return monthGrid(first).filter((c): c is string => c !== null)
}

/** The minimum a day needs for the rules below. */
export interface SelectableDay {
  status: DayStatus
  source: PriceSource
}

/**
 * Whether the host may act on a day.
 *
 * Two reasons they may not, and both matter: the past can't be repriced or
 * resold, and a night a guest already holds is priced by their reservation. A
 * day we have no data for is treated as editable — the grid paints months the
 * API hasn't returned yet, and locking them would make the calendar feel broken
 * while it loads.
 */
export function isDayEditable(
  date: string,
  day: SelectableDay | undefined,
  today: string
): boolean {
  if (!isIsoDate(date) || !isIsoDate(today)) return false
  if (date < today) return false
  return day?.status !== 'booked'
}

/** What the action bar may offer for the current selection. */
export interface SelectionStats {
  total: number
  /** Selected days that are currently closed — enables "Open". */
  blocked: number
  /** Selected days carrying a pinned price — enables "Reset to default". */
  custom: number
}

/**
 * Summarise a selection so the action bar can hide the buttons that would do
 * nothing. Offering "Open" for a selection with nothing blocked in it invites a
 * host to press a button that can only be a no-op.
 */
export function selectionStats(
  dates: readonly string[],
  days: Readonly<Record<string, SelectableDay | undefined>>
): SelectionStats {
  let blocked = 0
  let custom = 0
  for (const date of dates) {
    const day = days[date]
    if (day?.status === 'blocked') blocked++
    if (day?.source === 'custom') custom++
  }
  return { total: dates.length, blocked, custom }
}

/**
 * Split [from, to] into consecutive windows of at most `size` days, for fetching
 * a year of calendar in requests the API will accept. Returns [] when `from` is
 * already past `to`, so a fully-prefetched calendar issues no requests at all.
 */
export function chunkWindows(from: string, to: string, size: number): { start: string; end: string }[] {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from || size < 1) return []
  const out: { start: string; end: string }[] = []
  let cursor = from
  // Bounded by construction (cursor strictly increases), but capped anyway so a
  // bad `size` can never spin here.
  while (cursor <= to && out.length < 64) {
    const end = addDays(cursor, size - 1)
    out.push({ start: cursor, end: end > to ? to : end })
    cursor = addDays(cursor, size)
  }
  return out
}

// ---- Length-of-stay discount -------------------------------------------------
//
// A host can discount longer stays: `listings.weekly_discount` applies from 7 nights,
// `listings.monthly_discount` from 28. They are whole percentages off the summed
// nightly total, and only ONE applies — the monthly rate supersedes the weekly one
// rather than compounding with it.
//
// This lives here, shared and guarded, because it did not: quickin-backend applied the
// discount inside createBooking and the web did not apply it at all, so a 10-night stay
// on a listing with weekly_discount = 10 cost 10% less booked from the app than from
// the browser. Same listing, same dates, two prices.

/** Nights from which `weekly_discount` starts applying. */
export const WEEKLY_DISCOUNT_MIN_NIGHTS = 7
/** Nights from which `monthly_discount` takes over from the weekly one. */
export const MONTHLY_DISCOUNT_MIN_NIGHTS = 28

/**
 * The discount percentage for a stay of `nights`, given the listing's two rates.
 * The TypeScript twin of stayDiscountFactorSql below — both must answer the same,
 * which is what the unit tests assert.
 */
export function stayDiscountPercent(
  nights: number,
  weeklyDiscount: number | null | undefined,
  monthlyDiscount: number | null | undefined,
): number {
  const n = Number(nights)
  if (!Number.isFinite(n) || n <= 0) return 0
  const pick = n >= MONTHLY_DISCOUNT_MIN_NIGHTS ? monthlyDiscount
    : n >= WEEKLY_DISCOUNT_MIN_NIGHTS ? weeklyDiscount
    : 0
  const pct = Number(pick)
  if (!Number.isFinite(pct) || pct <= 0) return 0
  // A discount over 100% would invert the price and pay the guest to stay.
  return Math.min(pct, 100)
}

/**
 * The same rule as SQL: a multiplier to apply to the summed nightly total.
 * `checkInExpr`/`checkOutExpr` are SQL date expressions (typically the bound
 * parameters `$3` and `$4`); `listingAlias` is the aliased `listings` row.
 */
export function stayDiscountFactorSql(
  checkInExpr: string,
  checkOutExpr: string,
  listingAlias = 'l',
): string {
  const nights = `((${checkOutExpr})::date - (${checkInExpr})::date)`
  return `(1 - (LEAST(GREATEST(CASE
      WHEN ${nights} >= ${MONTHLY_DISCOUNT_MIN_NIGHTS} THEN COALESCE(${listingAlias}.monthly_discount, 0)
      WHEN ${nights} >= ${WEEKLY_DISCOUNT_MIN_NIGHTS}  THEN COALESCE(${listingAlias}.weekly_discount, 0)
      ELSE 0 END, 0), 100))::numeric / 100)`
}

/**
 * The seasonal rungs of the nightly ladder, as SQL: weekend rate, then that month's
 * rate, then the base price. `sqlWithDatePrice` puts the host's pinned calendar day
 * above all of it.
 *
 * The SQL twin of resolveNightPrice() above, and it exists because the twins had
 * silently come apart. Each project had written its own CASE and each was wrong in a
 * different direction: quickin-backend hardcoded Friday/Saturday and so ignored a host
 * who had set `weekend_days`, while the web honoured `weekend_days` but had no monthly
 * rung at all and skipped the weekend rate entirely when `weekend_days` was NULL. Since
 * resolveNightPrice is what the clients use to PREVIEW a price, both servers were
 * charging something the guest had not been quoted — differently.
 *
 * Keep this and resolveNightPrice in step: they must answer the same number for the
 * same day, and `npm run check` only proves this file matches across repos, not that
 * the two rungs below match each other.
 */
export function perNightSeasonalSql(dateExpr: string, listingAlias = 'l'): string {
  const l = listingAlias
  const month = `EXTRACT(MONTH FROM (${dateExpr}))::int::text`
  // NULLIF('{}') so an empty array falls back to the default rather than matching
  // nothing — mirrors `weekendDays.length > 0` in resolveNightPrice.
  const weekendDays = `COALESCE(NULLIF(${l}.weekend_days, '{}'), ARRAY[${DEFAULT_WEEKEND_DAYS.join(', ')}])`
  return `
  CASE
    WHEN ${l}.weekend_price IS NOT NULL
         AND EXTRACT(DOW FROM (${dateExpr}))::int = ANY(${weekendDays})
      THEN ${l}.weekend_price
    WHEN (${l}.monthly_prices ->> ${month}) ~ '^[0-9.]+$'
      THEN (${l}.monthly_prices ->> ${month})::numeric
    ELSE ${l}.price_per_night
  END`
}
