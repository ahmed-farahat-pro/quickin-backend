// Search ranking — the order chalets appear in when nobody has picked a sort.
//
// MODEL: a chalet earns its place. The default `recommended` order is no longer
// "newest first with the editorial favourites on top"; it is a score in [0, 1.05]
// built from how the property has actually performed:
//
//   score = RATING_WEIGHT   × rating component     (0…1)
//         + BOOKINGS_WEIGHT × bookings component   (0…1)
//         + FAVORITE_BONUS  if is_guest_favorite
//
// Two traps this is shaped to avoid:
//
//  1. **One 5-star review must not beat two hundred 4.7s.** Two mechanisms, and
//     it takes both:
//
//     a. A Bayesian (shrunk) mean, not a raw average: every listing is treated as
//        if it also carried PRIOR_REVIEWS reviews at the platform's own average,
//        so a lone 5★ lands near that average instead of at the top. This is also
//        the cold start — a new listing rates as average, never as zero.
//     b. A LOWER CONFIDENCE BOUND on that mean, not the mean itself. Shrinkage
//        alone is NOT enough, and this was caught against real rows rather than
//        reasoned about: shrinkage pulls a lone 5★ toward the platform average
//        but leaves it ABOVE it, so on a catalogue averaging 4.71 a single 5★
//        (shrunk to 4.76) still outranked forty reviews averaging 4.70 (4.70).
//        Subtracting an uncertainty penalty that shrinks as √n fixes it for good:
//        one review is worth ±0.5★ of doubt, forty is worth ±0.19★. A big body of
//        strong reviews now wins because we are SURE of it, which is the actual
//        thing the requirement is asking for.
//
//  2. **A cancelled booking is not a success.** The booking component counts only
//     stays that actually happened (see COMPLETED_BOOKING_SQL) — never a request,
//     never a pending hold, never something cancelled or rejected. It is log-damped
//     so the 1st→2nd stay matters far more than the 90th→91st, and saturates at
//     BOOKINGS_SATURATION, which keeps one huge operator from owning every page.
//
// Both halves are RECENCY-WEIGHTED (see recencyWeight): anything inside the last
// FULL_WEIGHT_DAYS counts in full, then fades on a straight line to a
// MIN_RECENCY_WEIGHT floor. A chalet that was busy three years ago and dead since
// drifts down; one that is performing now rises. Nothing ever falls to zero — old
// success still counts for something.
//
// No runtime imports, so `node --test` can import this file directly — see
// README → "Writing a testable module". db.ts imports this module; this module
// never imports db.ts.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// rank the same Neon rows for the same catalogue. If they drifted, the web and
// the apps would put the same two chalets in a different order.
// scripts/check-ranking-core-parity.mjs fails on drift, so edit one copy and
// paste it over the other verbatim.

// ---- Weights and constants ---------------------------------------------------
// Fixed here on purpose rather than in a settings row: ranking is not a knob an
// operator turns per-day, and a bad value typed into a form would reorder the
// whole catalogue with nothing to test it against. Changing these is a code edit,
// which means it goes through ranking-core.test.mjs first.

/** Share of the score carried by guest ratings. */
export const RATING_WEIGHT = 0.6

/** Share of the score carried by completed bookings. RATING_WEIGHT + this = 1. */
export const BOOKINGS_WEIGHT = 0.4

/** The Bayesian prior's strength, in reviews (the `m` of `(v·R + m·C)/(v + m)`).
 *  A listing needs roughly this many reviews before its own average dominates
 *  the platform average. Five is deliberately low — enough to defuse a single
 *  planted 5★, not so high that a genuinely excellent small chalet is buried. */
export const PRIOR_REVIEWS = 5

/** The prior's mean (`C`) when the platform itself has no reviews to average —
 *  a fresh or empty database. Mid-way up the 1–5 band, slightly optimistic
 *  because a real catalogue's mean sits well above the midpoint. */
export const PRIOR_RATING = 4.5

/**
 * How much rating a listing forfeits for being uncertain: the score is the mean
 * MINUS `RATING_CONFIDENCE_PENALTY / √(reviews + PRIOR_REVIEWS)`, i.e. the lower
 * end of a confidence interval rather than its centre.
 *
 * 1.28 is z at 90% one-sided × roughly one star of spread — the standard
 * deviation of real star ratings sits near 1.0, and assuming it rather than
 * computing it saves carrying Σr² through every query for a second decimal of
 * precision that would not change an ordering.
 *
 * What it buys, concretely: a single review costs 1.28/√6 = 0.52★ of doubt while
 * forty cost 1.28/√45 = 0.19★. That gap is what makes a large body of good
 * reviews beat a small body of perfect ones — the shrinkage above cannot do it
 * alone, see the header.
 */
export const RATING_CONFIDENCE_PENALTY = 1.28

/** Weighted completed bookings at which the booking component reaches 1.0.
 *  Past this a chalet gains nothing more from volume and competes on rating. */
export const BOOKINGS_SATURATION = 50

/** Editorial thumb on the scale for `listings.is_guest_favorite`. Small on
 *  purpose: before this module that flag WAS the entire recommended order, so
 *  dropping it outright would have been a silent product regression — but it
 *  must not outrank real performance either. At 0.05 it breaks ties and lifts a
 *  listing about one rating-star's worth, never more. */
export const FAVORITE_BONUS = 0.05

/** Reviews and stays this recent count at full weight. */
export const FULL_WEIGHT_DAYS = 365

/** How long the linear fade from full weight to the floor takes, after the
 *  full-weight window closes. */
export const DECAY_DAYS = 730

/** Floor for the fade — a five-year-old completed stay still counts this much.
 *  Never 0: history is evidence, just weaker evidence. */
export const MIN_RECENCY_WEIGHT = 0.25

/** The star scale ratings live on, used to normalise into [0, 1]. */
export const MIN_RATING = 1
export const MAX_RATING = 5

/** Highest score any listing can reach — a perfect performer that is also a
 *  guest favourite. Exported so a caller can normalise into a percentage. */
export const MAX_SCORE = RATING_WEIGHT + BOOKINGS_WEIGHT + FAVORITE_BONUS

// ---- Helpers -----------------------------------------------------------------

/** Coerce anything to a finite number ≥ 0. Every input here arrives from
 *  Postgres via `pg`, which hands back numerics as STRINGS and NULLs as null —
 *  and `Number(null)` is 0 while `Number(undefined)` is NaN, so a NaN leaking
 *  into the score would sort that listing arbitrarily. */
function nonNegative(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

// ---- The score ---------------------------------------------------------------

/**
 * How much a review or a completed stay from `ageDays` ago still counts.
 * Flat 1.0 inside the first year, then a straight line down to
 * MIN_RECENCY_WEIGHT — piecewise-linear rather than exponential precisely so the
 * SQL twin below can be read at a glance and can't round differently.
 */
export function recencyWeight(ageDays: number): number {
  const age = nonNegative(ageDays)
  if (age <= FULL_WEIGHT_DAYS) return 1
  return Math.max(MIN_RECENCY_WEIGHT, 1 - (age - FULL_WEIGHT_DAYS) / DECAY_DAYS)
}

/**
 * The shrunk average rating, on the 1–5 star scale: `(Σw·r + m·C) / (Σw + m)`.
 *
 * Takes the recency-weighted SUM of ratings and the weighted COUNT rather than
 * an average, because that is what one pass over `reviews` produces and because
 * dividing first would throw away the count the shrinkage needs. With no reviews
 * at all it returns exactly `globalAvgRating` — the defining property of the
 * cold start, and why this can't divide by zero.
 */
export function bayesianRating(
  weightedRatingSum: number,
  weightedReviewCount: number,
  globalAvgRating: number = PRIOR_RATING
): number {
  const sum = nonNegative(weightedRatingSum)
  const count = nonNegative(weightedReviewCount)
  const global = Number(globalAvgRating)
  const prior = clamp(Number.isFinite(global) && global > 0 ? global : PRIOR_RATING, MIN_RATING, MAX_RATING)
  return (sum + PRIOR_REVIEWS * prior) / (count + PRIOR_REVIEWS)
}

/**
 * The rating this module actually ranks on: the shrunk mean minus an uncertainty
 * penalty that decays as √n. Read it as "the rating we can be confident this
 * chalet is at least worth".
 *
 * This is the function that makes the headline requirement hold. bayesianRating
 * on its own does not — see the header, mechanism (b).
 */
export function confidentRating(
  weightedRatingSum: number,
  weightedReviewCount: number,
  globalAvgRating: number = PRIOR_RATING
): number {
  const mean = bayesianRating(weightedRatingSum, weightedReviewCount, globalAvgRating)
  const evidence = nonNegative(weightedReviewCount) + PRIOR_REVIEWS
  return clamp(mean - RATING_CONFIDENCE_PENALTY / Math.sqrt(evidence), MIN_RATING, MAX_RATING)
}

/** The rating half of the score, normalised to [0, 1]. */
export function ratingComponent(
  weightedRatingSum: number,
  weightedReviewCount: number,
  globalAvgRating: number = PRIOR_RATING
): number {
  const stars = confidentRating(weightedRatingSum, weightedReviewCount, globalAvgRating)
  return clamp((stars - MIN_RATING) / (MAX_RATING - MIN_RATING), 0, 1)
}

/**
 * The bookings half of the score, normalised to [0, 1]: `ln(1+n) / ln(1+S)`,
 * capped at 1. Log so that proving demand at all is worth much more than
 * extending an already long record — 5 stays reach 46% of the component while
 * 25 stays reach 83%, not 5× more.
 *
 * `Math.log(1 + n)` rather than `Math.log1p(n)` so the expression is literally
 * the same one the SQL twin evaluates (`ln(1.0 + n)`); at the magnitudes here
 * they agree anyway, but the parity is the point.
 */
export function bookingsComponent(weightedBookings: number): number {
  const n = nonNegative(weightedBookings)
  return Math.min(1, Math.log(1 + n) / Math.log(1 + BOOKINGS_SATURATION))
}

/** The recency-weighted aggregates one listing is scored from. */
export interface RankingInput {
  /** Σ (recency weight × star rating) over the listing's reviews. */
  weightedRatingSum?: number
  /** Σ (recency weight) over the same reviews. */
  weightedReviewCount?: number
  /** Σ (recency weight) over the listing's COMPLETED bookings. */
  weightedBookings?: number
  /** The platform-wide mean rating, the Bayesian prior's centre. */
  globalAvgRating?: number
  /** `listings.is_guest_favorite`. */
  isGuestFavorite?: boolean
}

/** The number the search results are ordered by, descending. Range [0, MAX_SCORE]. */
export function rankingScore(input: RankingInput = {}): number {
  return (
    RATING_WEIGHT * ratingComponent(
      input.weightedRatingSum ?? 0,
      input.weightedReviewCount ?? 0,
      input.globalAvgRating ?? PRIOR_RATING
    ) +
    BOOKINGS_WEIGHT * bookingsComponent(input.weightedBookings ?? 0) +
    (input.isGuestFavorite ? FAVORITE_BONUS : 0)
  )
}

/** The same score broken into its parts — for `/ops` and for explaining to a
 *  host why their listing sits where it does. Never used for ordering. */
export function rankingBreakdown(input: RankingInput = {}): {
  score: number
  rating: number
  bookings: number
  favorite: number
  /** The shrunk mean, in stars — what the chalet is believed to be worth. */
  bayesianRating: number
  /** The shrunk mean after the uncertainty penalty — what it is RANKED on. The
   *  gap between the two is the price of having few reviews. */
  confidentRating: number
} {
  const rating = ratingComponent(
    input.weightedRatingSum ?? 0,
    input.weightedReviewCount ?? 0,
    input.globalAvgRating ?? PRIOR_RATING
  )
  const bookings = bookingsComponent(input.weightedBookings ?? 0)
  const favorite = input.isGuestFavorite ? FAVORITE_BONUS : 0
  return {
    score: RATING_WEIGHT * rating + BOOKINGS_WEIGHT * bookings + favorite,
    rating,
    bookings,
    favorite,
    bayesianRating: bayesianRating(
      input.weightedRatingSum ?? 0,
      input.weightedReviewCount ?? 0,
      input.globalAvgRating ?? PRIOR_RATING
    ),
    confidentRating: confidentRating(
      input.weightedRatingSum ?? 0,
      input.weightedReviewCount ?? 0,
      input.globalAvgRating ?? PRIOR_RATING
    ),
  }
}

// ---- SQL ---------------------------------------------------------------------
// The score has to be computed inside Postgres — ordering the whole catalogue in
// JavaScript would mean fetching every listing with every review and every
// booking attached. These builders keep ONE definition of the rule, so the SQL
// and the TypeScript above can never disagree about an order.
//
// Everything is cast to float8 (IEEE double) rather than left as `numeric`, so
// Postgres does the same binary arithmetic the JS twin does and the two can be
// asserted equal instead of merely close.

/**
 * What counts as a successful booking, and the single reason this feature is not
 * just "count the bookings rows": a cancelled or rejected reservation must never
 * lift a listing, and neither must a request nobody has honoured yet.
 *
 * Two shapes qualify, matching how the rest of the codebase decides a stay is
 * done (see reviews.ts, which lets a guest review on exactly this condition):
 * the explicit `completed` status an admin or host sets, and the far more common
 * `confirmed` booking whose check-out date has passed. `pending`, `cancelled`
 * and `rejected` are all excluded.
 */
export function sqlCompletedBooking(alias = 'b'): string {
  return `(${alias}.status = 'completed' OR (${alias}.status = 'confirmed' AND ${alias}.check_out < now()))`
}

/** Age of a timestamp in days, floored at 0 so a clock skew into the future
 *  can't produce a weight above 1. */
export function sqlAgeDays(tsExpr: string): string {
  return `GREATEST(EXTRACT(EPOCH FROM (now() - (${tsExpr})))::float8 / 86400.0, 0.0)`
}

/** SQL twin of recencyWeight(). */
export function sqlRecencyWeight(tsExpr: string): string {
  const age = sqlAgeDays(tsExpr)
  return `(CASE WHEN ${age} <= ${FULL_WEIGHT_DAYS}.0 THEN 1.0::float8
      ELSE GREATEST(${MIN_RECENCY_WEIGHT}::float8, 1.0 - (${age} - ${FULL_WEIGHT_DAYS}.0) / ${DECAY_DAYS}.0) END)`
}

/** The platform-wide mean rating — the Bayesian prior's centre. Uncorrelated, so
 *  Postgres evaluates it once per query, not once per listing. */
export const GLOBAL_AVG_RATING_SQL =
  `COALESCE((SELECT avg(rating)::float8 FROM reviews), ${PRIOR_RATING}::float8)`

/** Σ (recency weight × rating) over a listing's reviews. */
export function sqlWeightedRatingSum(alias = 'l'): string {
  return `COALESCE((SELECT sum(${sqlRecencyWeight('rr.created_at')} * rr.rating::float8)
      FROM reviews rr WHERE rr.listing_id = ${alias}.id), 0.0::float8)`
}

/** Σ (recency weight) over the same reviews — the shrinkage's `v`. */
export function sqlWeightedReviewCount(alias = 'l'): string {
  return `COALESCE((SELECT sum(${sqlRecencyWeight('rr.created_at')})
      FROM reviews rr WHERE rr.listing_id = ${alias}.id), 0.0::float8)`
}

/** Σ (recency weight) over a listing's COMPLETED bookings, aged from check-out —
 *  when the stay actually happened, not when it was requested. */
export function sqlWeightedBookings(alias = 'l'): string {
  return `COALESCE((SELECT sum(${sqlRecencyWeight('bb.check_out')})
      FROM bookings bb
     WHERE bb.listing_id = ${alias}.id AND ${sqlCompletedBooking('bb')}), 0.0::float8)`
}

/** SQL twin of rankingScore(), as one expression over the listings alias. */
export function sqlRankingScore(alias = 'l'): string {
  // `evidence` is the shrinkage denominator AND the √n the penalty divides by,
  // so it is written once and reused — the two must never disagree.
  const evidence = `((${sqlWeightedReviewCount(alias)}) + ${PRIOR_REVIEWS}.0)`
  const bayes =
    `((${sqlWeightedRatingSum(alias)}) + ${PRIOR_REVIEWS}.0 * ${GLOBAL_AVG_RATING_SQL}) / ${evidence}`
  const confident =
    `GREATEST(${MIN_RATING}.0, LEAST(${MAX_RATING}.0,` +
    ` (${bayes}) - ${RATING_CONFIDENCE_PENALTY} / sqrt(${evidence})))`
  const rating =
    `LEAST(1.0, GREATEST(0.0, ((${confident}) - ${MIN_RATING}.0) / ${MAX_RATING - MIN_RATING}.0))`
  const bookings =
    `LEAST(1.0, ln(1.0 + (${sqlWeightedBookings(alias)})) / ln(1.0 + ${BOOKINGS_SATURATION}.0))`
  const favorite =
    `(CASE WHEN COALESCE(${alias}.is_guest_favorite, false) THEN ${FAVORITE_BONUS}::float8 ELSE 0.0::float8 END)`
  return `(${RATING_WEIGHT} * ${rating} + ${BOOKINGS_WEIGHT} * ${bookings} + ${favorite})`
}

/**
 * The whole `ORDER BY` for the default search order. `created_at DESC` breaks
 * ties, so two listings with no history yet still come back newest-first —
 * exactly the order this replaced — and the order is total, which keeps results
 * stable across pages instead of letting Postgres pick.
 */
export function sqlRankingOrderBy(alias = 'l'): string {
  return `${sqlRankingScore(alias)} DESC, ${alias}.created_at DESC`
}
