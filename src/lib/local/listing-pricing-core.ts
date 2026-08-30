// Listing pricing input rules — the weekend rate a host types on `/host/new` and
// `/host/:id/edit`, and the same rate the mobile apps PATCH.
//
// Weekend pricing is optional: an empty field means "no weekend rate", and that
// is what clears it. What is NOT optional is that a rate the host actually typed
// has to be money. `0` was swallowed silently at every layer — the web form
// coerced it away, both mobile pricing screens parsed it to nil, `createListing`
// and `updateListing` wrote NULL — so the listing saved with the weekend-day
// pills still lit up and no weekend price behind them. The host had no way to
// tell the rate they entered had been dropped. A refusal is the only honest
// answer: 0 is either a typo or a misunderstanding of the field, and both
// deserve to be said out loud.
//
// Every door now runs this file or a twin of it: the two web forms import it
// directly, `createListing`/`updateListing` run it before they write, and the
// iOS (`ListingPricingRules.swift`) and Android (`ListingPricingRules.kt`)
// pricing screens answer the same two questions in the same two words, so a
// host is told by the screen they are typing into rather than by a 400.
//
// The days are deliberately not part of *that* rule. `DEFAULT_WEEKEND_DAYS` is
// pre-selected on both forms, so "days chosen but no price" is the *normal*
// state of a listing with no weekend rate, not an error. They have a rule of
// their own further down, and it asks a different question: not whether a rate
// was typed, but whether what was lit up is still a weekend.
//
// No runtime imports, so `node --test` can import this file directly — see
// README → Testing. db.ts and the forms import the core, never the reverse.

/** How a typed weekend price can fail. Clients switch on this, not on text. */
export type WeekendPriceProblem =
  /** Not a number at all — `abc`, `1,500`, `--`. */
  | 'notANumber'
  /** A number, but not a price — `0`, `-200`. */
  | 'notPositive'

export type WeekendPriceResult =
  /** `null` = the host left it empty, i.e. no weekend rate (clears a stored one). */
  | { ok: true; value: number | null }
  | { ok: false; problem: WeekendPriceProblem }

/**
 * Validate what the host typed (or what a client sent) for `weekend_price`.
 *
 * Empty is fine and means "no weekend rate": `undefined`, `null`, `''` and a
 * blank string all answer `{ ok: true, value: null }`. Anything else must parse
 * to a finite number greater than zero.
 */
export function checkWeekendPrice(input: unknown): WeekendPriceResult {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (typeof input === 'string' && input.trim() === '') return { ok: true, value: null }
  // `Number(true)` is 1 and `Number([])` is 0 — neither is a price a host typed.
  if (typeof input !== 'number' && typeof input !== 'string') return { ok: false, problem: 'notANumber' }
  const n = Number(input)
  if (!Number.isFinite(n)) return { ok: false, problem: 'notANumber' }
  if (n <= 0) return { ok: false, problem: 'notPositive' }
  return { ok: true, value: n }
}

/** English message for a rejected weekend price — what the API answers with. */
export function weekendPriceMessage(problem: WeekendPriceProblem): string {
  return problem === 'notPositive'
    ? 'Weekend price must be greater than 0'
    : 'Weekend price must be a number'
}

// ---------------------------------------------------------------------------
// Which days count as the weekend
// ---------------------------------------------------------------------------
//
// A weekend is a *part* of the week. The day pills let a host light up all seven
// and save, which prices every night at the weekend rate and leaves the nightly
// price — the field right above it, the one the whole listing is advertised on —
// applying to nothing. A host doing that almost certainly means "my rate is X",
// and the field for that is `price_per_night`.
//
// So: at most six of seven. Zero days is still fine and still means nothing is a
// weekend (see the note above about days without a rate), and every day but one
// is a strange weekend but an honest one — the line is only drawn where the
// nightly price stops existing.

/** Days in a week — the ceiling `weekend_days` has to stay under. */
export const DAYS_IN_WEEK = 7

/** How a weekend-day set can fail. Clients switch on this, not on text. */
export type WeekendDaysProblem =
  /** All seven days chosen, which leaves `price_per_night` unreachable. */
  | 'wholeWeek'
  /** A rate was typed, but no day was left lit to charge it on — see
   *  resolveWeekendSchedule. Shape alone can't raise this one: an empty set is
   *  perfectly fine until a rate turns up beside it. */
  | 'noDaysChosen'

export type WeekendDaysResult =
  /** The cleaned set: 0..6 integers, deduped, ascending. May be empty. */
  | { ok: true; value: number[] }
  | { ok: false; problem: WeekendDaysProblem }

/**
 * Clean a day set without judging it: keep whole days in 0..6 (Postgres DOW,
 * `0`=Sun … `6`=Sat), drop everything else, drop repeats, sort ascending.
 *
 * Repeats are dropped here rather than tolerated because they are what a
 * whole-week set can hide behind — `[5, 5, 6]` is two days, not three, and a
 * count taken before deduping would answer the wrong question.
 */
export function normalizeWeekendDays(input: unknown): number[] {
  if (!Array.isArray(input)) return []
  const out: number[] = []
  for (const raw of input) {
    // `Number(true)` is 1 and `Number(null)` is 0 — Monday and Sunday out of
    // nothing. Only a number or a numeric string is a day.
    if (typeof raw !== 'number' && typeof raw !== 'string') continue
    const n = Number(raw)
    // Not floored: `3.7` is a typo, not Wednesday.
    if (!Number.isInteger(n) || n < 0 || n > DAYS_IN_WEEK - 1) continue
    if (!out.includes(n)) out.push(n)
  }
  return out.sort((a, b) => a - b)
}

/**
 * Validate what the host lit up (or what a client sent) for `weekend_days`.
 *
 * Answers the cleaned set, or refuses the one set that cannot mean what it says:
 * all seven days, which is a nightly price wearing a weekend's name.
 */
export function checkWeekendDays(input: unknown): WeekendDaysResult {
  const value = normalizeWeekendDays(input)
  if (value.length >= DAYS_IN_WEEK) return { ok: false, problem: 'wholeWeek' }
  return { ok: true, value }
}

const WEEKEND_DAYS_MESSAGES: Record<WeekendDaysProblem, string> = {
  wholeWeek: 'Weekend pricing cannot apply to all seven days — set the nightly price instead',
  noDaysChosen: 'Pick at least one weekend day, or clear the weekend price',
}

/** English message for a rejected weekend-day set — what the API answers with. */
export function weekendDaysMessage(problem: WeekendDaysProblem): string {
  return WEEKEND_DAYS_MESSAGES[problem]
}

// ---------------------------------------------------------------------------
// The rate and the days, as one thing
// ---------------------------------------------------------------------------
//
// Each half is now well-formed on its own, and a listing could still save with
// a weekend rate that no night can ever be charged at: type a rate, turn every
// day pill off, submit. The storage layer already believed the pair was a pair
// — createListing wrote `price && days.length ? days : null`, and the booking
// quote only reaches for the rate when `weekend_days IS NOT NULL` — so the rate
// went into the row and nothing was ever priced with it. No error, no hint; the
// host leaves believing their weekends are dearer than their weekdays.
//
// That is the same silent drop `0` used to be, arriving through the other half
// of the field, and it gets the same answer: refuse, and say which half to fix.
//
// The asymmetry with the rate is deliberate and stays. Days with no rate is the
// resting state of every listing that doesn't use weekend pricing (both forms
// pre-select DEFAULT_WEEKEND_DAYS before the host has typed anything), so it
// cannot be an error. A rate with no days is not a resting state — it is a
// number the host entered and will never see used.
// ---------------------------------------------------------------------------

/** Days-of-week that count as "weekend" by default (Egypt: Fri=5, Sat=6).
 *  Re-exported by `lib/geo`, which is where the forms and the client-side quote
 *  have always imported it from. */
export const DEFAULT_WEEKEND_DAYS: number[] = [5, 6]

export type WeekendScheduleResult =
  /** What to store in `weekend_days`. `null` = store no days, which is what a
   *  listing with no weekend rate looks like. */
  | { ok: true; days: number[] | null }
  | { ok: false; problem: WeekendDaysProblem }

/**
 * The day set to store beside `price` — the one place that decides what a
 * (rate, days) pair means, so the create door, the edit door and both forms
 * cannot drift apart on it.
 *
 * `supplied` being `undefined` is load-bearing, and is why this takes `unknown`
 * rather than an array: an absent day set and an empty one are different
 * statements, and squashing them together is what left the mobile apps writing
 * NULL days under a real rate.
 *
 * - **absent** (`undefined`) — the client never mentions days, so the host was
 *   never asked. Both mobile apps are here: their pricing screens say "Applied
 *   on Fri + Sat nights" and send `weekend_price` alone. They get
 *   `DEFAULT_WEEKEND_DAYS` — what their own UI promised the host, and what they
 *   silently failed to get before.
 * - **empty** (`[]`) — the client showed the host the day pills and the host
 *   left none lit. That is the web forms, and it is the bug: refuse it rather
 *   than guess Fri+Sat, because a host who cleared every pill on purpose should
 *   not have two put back without being told.
 * - **anything else** — cleaned and judged by `checkWeekendDays`, so a whole
 *   week is still refused here too.
 *
 * `price` is the rate *after* `checkWeekendPrice` has had it — a real number or
 * nothing, never the raw string a host typed.
 *
 * With no rate there is nothing to schedule and the answer is always `null`:
 * clearing the rate clears the days, at every door, and without a word about
 * what the days looked like on the way out.
 */
export function resolveWeekendSchedule(
  price: number | null | undefined,
  supplied: unknown
): WeekendScheduleResult {
  // The rate is consulted first, and nothing about the days is judged without
  // one. That ordering is load-bearing: a listing saved before the whole-week
  // rule existed still loads with all seven pills lit, and clearing the rate is
  // exactly how its host turns weekend pricing off. Judging the shape first
  // would refuse that save and strand them on a form they are in the middle of
  // fixing — and for a day set that is about to be dropped either way.
  if (typeof price !== 'number' || price <= 0) return { ok: true, days: null }
  if (supplied === undefined) return { ok: true, days: [...DEFAULT_WEEKEND_DAYS] }
  const checked = checkWeekendDays(supplied)
  if (!checked.ok) return checked
  if (checked.value.length === 0) return { ok: false, problem: 'noDaysChosen' }
  return { ok: true, days: checked.value }
}

// ---------------------------------------------------------------------------
// Seasonal pricing: the per-month nightly rates
// ---------------------------------------------------------------------------
//
// `listings.monthly_prices` is a jsonb map, month "1".."12" → nightly rate, and
// it is the rung of the ladder directly under the weekend rate:
//
//     host calendar (listing_date_prices) → weekend → month → price_per_night
//
// (see date-pricing-core.ts, which owns the ladder itself.) A month with no
// entry is not priced at zero — it simply has no opinion and falls through to
// the base nightly price, so a blank field is how a host CLEARS a month.
//
// The rule for a month a host did fill in is the weekend rate's rule, for the
// same reason: `0` is a typo or a misreading of the field, never "free in
// August", and the storage layer used to drop it silently (`cleanMonthlyPrices`
// on the API side kept only positive months). A dropped month looks exactly like
// a month that was never set, so the host had no way to tell their August rate
// went nowhere. Refuse it, and name the month that has to be fixed — which is
// what `month` on the failure is for, and why `monthPriceMessage` exists.

/** Months in a year — the keys `monthly_prices` is indexed by, 1..12. */
export const MONTHS_IN_YEAR = 12

/** How one typed month rate can fail. Clients switch on this, not on text. */
export type MonthPriceProblem =
  /** Not a number at all — `abc`, `1,500`, `--`. */
  | 'notANumber'
  /** A number, but not a price — `0`, `-200`. */
  | 'notPositive'

export type MonthlyPricesResult =
  /** The cleaned map: only the months the host priced, as positive whole
   *  numbers. `{}` is normal and means "no seasonal months". */
  | { ok: true; value: Record<string, number> }
  /** `month` is 1..12, so the caller can say WHICH month is wrong. */
  | { ok: false; problem: MonthPriceProblem; month: number }

/**
 * Validate a month → nightly-rate map (values as typed: strings from a form, or
 * numbers from a client). Blank, `null` and `undefined` entries are dropped —
 * that is a month with no override, not an error. Keys outside 1..12 are
 * dropped too: they cannot be reached by the ladder, so there is nothing to
 * tell the host about them.
 *
 * Answers the cleaned map in ascending month order, or the first month whose
 * value was typed and is not a price.
 */
export function checkMonthlyPrices(input: unknown): MonthlyPricesResult {
  if (!input || typeof input !== 'object') return { ok: true, value: {} }
  const entries = Object.entries(input as Record<string, unknown>)
  // Sorted so the month reported back is the FIRST bad one on the form rather
  // than whichever the object happened to enumerate first.
  const months = entries
    .map(([k, v]) => [Number(k), v] as const)
    .filter(([m]) => Number.isInteger(m) && m >= 1 && m <= MONTHS_IN_YEAR)
    .sort((a, b) => a[0] - b[0])
  const out: Record<string, number> = {}
  for (const [month, raw] of months) {
    const checked = checkWeekendPrice(raw)
    if (!checked.ok) return { ok: false, problem: checked.problem, month }
    if (checked.value === null) continue
    out[String(month)] = Math.round(checked.value)
  }
  return { ok: true, value: out }
}

/** Month 1..12 → its English name. Only the API says these out loud: the web
 *  forms and both mobile apps name the month in the reader's own language, from
 *  their own month formatter. */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * English message for a rejected month rate — what the API answers with, and
 * the reason `checkMonthlyPrices` reports WHICH month rather than just failing.
 *
 * A host with one bad month among twelve fields needs to be told which one; a
 * bare "seasonal price must be greater than 0" sends them hunting.
 */
export function monthPriceMessage(problem: MonthPriceProblem, month: number): string {
  const name = MONTH_NAMES[month - 1] ?? `Month ${month}`
  return problem === 'notPositive'
    ? `${name} price must be greater than 0`
    : `${name} price must be a number`
}

// ---------------------------------------------------------------------------
// Length-of-stay discounts
// ---------------------------------------------------------------------------
//
// `listings.weekly_discount` comes off a stay of WEEKLY_DISCOUNT_MIN_NIGHTS or
// more, `listings.monthly_discount` from MONTHLY_DISCOUNT_MIN_NIGHTS — whole
// percentages off the summed nightly total, and only one of them applies (see
// stayDiscountPercent in date-pricing-core.ts, which is the rule itself).
//
// The ceiling is 90, matching the API's clamp. It is a clamp there and a
// refusal here for the usual reason: the API is clamping values arriving from
// clients that never showed the host a field, while a host who typed 95 into a
// field that saves 90 is owed the correction rather than the surprise.

/** The most a host may take off a long stay, in whole percent. */
export const MAX_STAY_DISCOUNT = 90

/** How a typed length-of-stay discount can fail. */
export type StayDiscountProblem =
  /** Not a number at all — `abc`, `10%`, `--`. */
  | 'notANumber'
  /** A number, but not a whole percent — `7.5`. */
  | 'notWhole'
  /** Whole, but outside 0..MAX_STAY_DISCOUNT — `-5`, `95`. */
  | 'outOfRange'

export type StayDiscountResult =
  /** `0` = no discount, which is what an empty field means and what clears one. */
  | { ok: true; value: number }
  | { ok: false; problem: StayDiscountProblem }

/**
 * Validate what the host typed for `weekly_discount` / `monthly_discount`.
 *
 * Empty means no discount rather than "leave it alone": these are `NOT NULL
 * DEFAULT 0` columns, so `0` is both the resting value and the way back to it.
 */
export function checkStayDiscount(input: unknown): StayDiscountResult {
  if (input === undefined || input === null) return { ok: true, value: 0 }
  if (typeof input === 'string' && input.trim() === '') return { ok: true, value: 0 }
  if (typeof input !== 'number' && typeof input !== 'string') return { ok: false, problem: 'notANumber' }
  const n = Number(input)
  if (!Number.isFinite(n)) return { ok: false, problem: 'notANumber' }
  // Floored rather than refused on the API side; refused here — a host who
  // typed 7.5 meant something, and 7 is not obviously it.
  if (!Number.isInteger(n)) return { ok: false, problem: 'notWhole' }
  if (n < 0 || n > MAX_STAY_DISCOUNT) return { ok: false, problem: 'outOfRange' }
  return { ok: true, value: n }
}

/**
 * Do these two discounts invert — i.e. does the monthly rate take LESS off than
 * the weekly one it supersedes?
 *
 * Only one discount ever applies, so weekly 20 / monthly 10 means a 28-night
 * stay costs more than a 27-night one on the same listing. That is legal, and
 * a host may even want it, so it is not refused at any door — but it is almost
 * always a mistake, and the forms say so beside the fields.
 */
export function stayDiscountsInvert(weekly: number, monthly: number): boolean {
  return monthly > 0 && weekly > 0 && monthly < weekly
}
