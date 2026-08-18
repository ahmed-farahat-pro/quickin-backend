// Unit tests for src/lib/local/ranking-core.ts — the performance score that
// orders chalets in the default `recommended` search.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. ranking-core.ts has no relative imports, which is what
// makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOKINGS_SATURATION,
  BOOKINGS_WEIGHT,
  DECAY_DAYS,
  FAVORITE_BONUS,
  FULL_WEIGHT_DAYS,
  GLOBAL_AVG_RATING_SQL,
  MAX_RATING,
  MAX_SCORE,
  MIN_RATING,
  MIN_RECENCY_WEIGHT,
  PRIOR_RATING,
  PRIOR_REVIEWS,
  RATING_CONFIDENCE_PENALTY,
  RATING_WEIGHT,
  bayesianRating,
  bookingsComponent,
  confidentRating,
  rankingBreakdown,
  rankingScore,
  ratingComponent,
  recencyWeight,
  sqlAgeDays,
  sqlCompletedBooking,
  sqlRankingOrderBy,
  sqlRankingScore,
  sqlRecencyWeight,
  sqlWeightedBookings,
  sqlWeightedRatingSum,
  sqlWeightedReviewCount,
} from '../../src/lib/local/ranking-core.ts'

/** Recent reviews all carry weight 1, so the weighted sum is just n × stars. */
const reviews = (count, stars) => ({ weightedRatingSum: count * stars, weightedReviewCount: count })

describe('the weights', () => {
  test('rating and bookings split the score, and only the favourite bonus exceeds 1', () => {
    assert.equal(RATING_WEIGHT + BOOKINGS_WEIGHT, 1)
    assert.equal(MAX_SCORE, 1 + FAVORITE_BONUS)
  })

  test('rating outweighs bookings — a well-reviewed chalet beats a merely busy one', () => {
    assert.ok(RATING_WEIGHT > BOOKINGS_WEIGHT)
  })
})

describe('bayesianRating', () => {
  test('with no reviews it IS the platform average — the cold start, and no divide by zero', () => {
    assert.equal(bayesianRating(0, 0, 4.2), 4.2)
    assert.equal(bayesianRating(0, 0), PRIOR_RATING)
  })

  test('shrinks a lone 5-star review toward the platform average', () => {
    // (5 + 5×4.5) / (1 + 5) = 4.5833… — nowhere near the 5.0 a raw average gives.
    const r = bayesianRating(5, 1, 4.5)
    assert.ok(r > 4.5 && r < 4.6, `got ${r}`)
  })

  test('a large body of reviews overwhelms the prior', () => {
    // 200 reviews at 4.7 land within a hundredth of their own average.
    const r = bayesianRating(200 * 4.7, 200, 4.5)
    assert.ok(Math.abs(r - 4.7) < 0.01, `got ${r}`)
  })

  test('a bad or missing global average falls back rather than poisoning every score', () => {
    for (const bad of [null, undefined, NaN, 0, -3, 'abc']) {
      assert.equal(bayesianRating(0, 0, bad), PRIOR_RATING, `for ${String(bad)}`)
    }
    // Out of band (a corrupt aggregate) is clamped onto the star scale.
    assert.equal(bayesianRating(0, 0, 900), MAX_RATING)
  })

  test('reads Postgres numerics, which arrive as strings', () => {
    assert.equal(bayesianRating('940', '200', '4.5'), bayesianRating(940, 200, 4.5))
  })
})

describe('confidentRating', () => {
  test('is always below the mean it is derived from — uncertainty only ever costs', () => {
    for (const [n, avg] of [[0, 0], [1, 5], [10, 4.5], [500, 4.8]]) {
      const mean = bayesianRating(n * avg, n, 4.6)
      assert.ok(confidentRating(n * avg, n, 4.6) < mean, `at n=${n}`)
    }
  })

  test('the penalty shrinks as the square root of the evidence', () => {
    const gap = (n) => bayesianRating(n * 4.6, n, 4.6) - confidentRating(n * 4.6, n, 4.6)
    assert.ok(Math.abs(gap(0) - RATING_CONFIDENCE_PENALTY / Math.sqrt(PRIOR_REVIEWS)) < 1e-12)
    // Four times the reviews ⇒ about half the doubt.
    assert.ok(Math.abs(gap(20) / gap(95) - 2) < 0.15, `${gap(20)} vs ${gap(95)}`)
  })

  test('converges on the true average once the reviews are overwhelming', () => {
    assert.ok(Math.abs(confidentRating(5000 * 4.7, 5000, 4.5) - 4.7) < 0.03)
  })

  test('never leaves the star scale', () => {
    assert.ok(confidentRating(0, 0, 1) >= MIN_RATING)
    assert.ok(confidentRating(10_000 * 5, 10_000, 5) <= MAX_RATING)
  })
})

describe('ratingComponent', () => {
  test('normalises the star scale into [0,1]', () => {
    // A perfect chalet with a huge review body approaches 1; the floor is 0.
    assert.ok(ratingComponent(1000 * 5, 1000, 4.5) > 0.98)
    assert.ok(ratingComponent(1000 * 1, 1000, 4.5) < 0.01)
  })

  test('THE HEADLINE RULE: one 5-star review does not outrank 200 positive ones', () => {
    const lone = ratingComponent(...Object.values(reviews(1, 5)), 4.5)
    const many = ratingComponent(...Object.values(reviews(200, 4.7)), 4.5)
    assert.ok(many > lone, `200×4.7 (${many}) must beat 1×5.0 (${lone})`)
    // And the naive average — the thing this replaces — would have said otherwise.
    assert.ok(5 > 4.7)
  })

  test('...AT EVERY PLATFORM AVERAGE, not just a convenient one', () => {
    // REGRESSION. The first cut of this module shrank toward the platform mean and
    // stopped there, and this suite passed — because it only ever asked at C=4.5.
    // Run against real rows on a catalogue averaging 4.71, a single 5★ (shrunk to
    // 4.76) beat forty reviews at 4.70. Shrinkage moves a lone review toward the
    // mean but leaves it above; only the √n confidence penalty pushes it below.
    // So sweep C across the plausible range, INCLUDING values above both averages,
    // against bodies at, above, and just below the platform average.
    for (const globalAvg of [4, 4.3, 4.5, 4.7, 4.71, 4.9, 5]) {
      for (const n of [40, 200, 1000]) {
        for (const avg of [globalAvg, Math.min(5, globalAvg + 0.1), globalAvg - 0.1]) {
          const lone = ratingComponent(...Object.values(reviews(1, 5)), globalAvg)
          const many = ratingComponent(...Object.values(reviews(n, avg)), globalAvg)
          assert.ok(many > lone, `at C=${globalAvg}, ${n}×${avg} (${many}) must beat 1×5.0 (${lone})`)
        }
      }
    }
  })

  test('THE BOUNDARY: a large body of genuinely BELOW-average reviews does lose', () => {
    // Not a bug — the requirement asks for "hundreds of POSITIVE reviews", and
    // ranking on stronger customer reviews has to respect the average too. On a
    // catalogue averaging 4.99, a chalet confidently known to be 4.5 is a weak
    // listing, and an unproven one is allowed to sit above it. The line falls
    // where the body's average drops far enough below the platform's that being
    // sure of it stops being an advantage.
    const lone = ratingComponent(...Object.values(reviews(1, 5)), 4.99)
    assert.ok(ratingComponent(...Object.values(reviews(1000, 4.5)), 4.99) < lone)
    // …and the same body IS enough on any normal catalogue.
    assert.ok(
      ratingComponent(...Object.values(reviews(1000, 4.5)), 4.5) >
      ratingComponent(...Object.values(reviews(1, 5)), 4.5)
    )
  })

  test('a handful of perfect reviews still loses to a large body of strong ones', () => {
    // The rule is about confidence, so it must not collapse the moment n is 2 or 3.
    for (const n of [1, 2, 3, 5]) {
      const few = ratingComponent(...Object.values(reviews(n, 5)), 4.7)
      const many = ratingComponent(...Object.values(reviews(300, 4.7)), 4.7)
      assert.ok(many > few, `300×4.7 (${many}) must beat ${n}×5.0 (${few})`)
    }
    // At which point it flips is a real property: enough perfect reviews IS better.
    const lots = ratingComponent(...Object.values(reviews(300, 5)), 4.7)
    assert.ok(lots > ratingComponent(...Object.values(reviews(300, 4.7)), 4.7))
  })

  test('but a genuinely excellent chalet still climbs as reviews accumulate', () => {
    const scores = [1, 5, 20, 100].map((n) => ratingComponent(n * 5, n, 4.5))
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] > scores[i - 1], `${scores[i]} should exceed ${scores[i - 1]}`)
    }
  })

  test('a listing with poor reviews sinks below one with none', () => {
    const bad = ratingComponent(20 * 2, 20, 4.5)
    const none = ratingComponent(0, 0, 4.5)
    assert.ok(bad < none)
  })
})

describe('bookingsComponent', () => {
  test('no completed stays scores zero', () => {
    assert.equal(bookingsComponent(0), 0)
    assert.equal(bookingsComponent(null), 0)
    assert.equal(bookingsComponent(undefined), 0)
    assert.equal(bookingsComponent(-4), 0)
  })

  test('saturates at BOOKINGS_SATURATION and is capped there', () => {
    assert.equal(bookingsComponent(BOOKINGS_SATURATION), 1)
    assert.equal(bookingsComponent(BOOKINGS_SATURATION * 10), 1)
  })

  test('is log-damped: the first stays are worth far more than the hundredth', () => {
    const firstFive = bookingsComponent(5) - bookingsComponent(0)
    const nextFive = bookingsComponent(45) - bookingsComponent(40)
    assert.ok(firstFive > nextFive * 5, `${firstFive} vs ${nextFive}`)
  })

  test('is monotonic — one more completed stay never lowers a listing', () => {
    let prev = -1
    for (let n = 0; n <= 60; n++) {
      const s = bookingsComponent(n)
      assert.ok(s >= prev, `dipped at n=${n}`)
      prev = s
    }
  })

  test('accepts the fractional totals recency weighting produces', () => {
    assert.ok(bookingsComponent(3.75) > bookingsComponent(3))
  })
})

describe('recencyWeight', () => {
  test('anything inside the full-weight window counts in full', () => {
    assert.equal(recencyWeight(0), 1)
    assert.equal(recencyWeight(FULL_WEIGHT_DAYS), 1)
  })

  test('fades on a straight line once the window closes', () => {
    assert.equal(recencyWeight(FULL_WEIGHT_DAYS + DECAY_DAYS / 2), 0.5)
    assert.ok(recencyWeight(FULL_WEIGHT_DAYS + 1) < 1)
  })

  test('never reaches zero — old success is weaker evidence, not no evidence', () => {
    assert.equal(recencyWeight(FULL_WEIGHT_DAYS + DECAY_DAYS), MIN_RECENCY_WEIGHT)
    assert.equal(recencyWeight(100_000), MIN_RECENCY_WEIGHT)
  })

  test('a future timestamp (clock skew) cannot score above full weight', () => {
    assert.equal(recencyWeight(-500), 1)
    assert.equal(recencyWeight(NaN), 1)
  })

  test('is monotonically non-increasing with age', () => {
    let prev = 2
    for (const age of [0, 100, 365, 366, 500, 730, 1095, 2000, 5000]) {
      const w = recencyWeight(age)
      assert.ok(w <= prev, `rose at age ${age}`)
      prev = w
    }
  })
})

describe('rankingScore', () => {
  test('a brand-new listing rates as an unproven average — never as zero', () => {
    const fresh = rankingScore({ globalAvgRating: 4.5 })
    assert.equal(fresh, RATING_WEIGHT * ratingComponent(0, 0, 4.5))
    assert.ok(fresh > 0, 'a new listing must still be rankable, not zeroed out')
    // It sits below the platform average, by exactly the doubt of having no
    // reviews — which is what leaves room for a proven listing to rank above it.
    assert.ok(fresh < RATING_WEIGHT * ((4.5 - MIN_RATING) / (MAX_RATING - MIN_RATING)))
  })

  test('a new listing outranks one with the same history but bad reviews', () => {
    for (const weightedBookings of [0, 8, 40]) {
      assert.ok(
        rankingScore({ weightedBookings, globalAvgRating: 4.5 }) >
        rankingScore({ ...reviews(30, 2.5), weightedBookings, globalAvgRating: 4.5 }),
        `at ${weightedBookings} stays`
      )
    }
  })

  test('bookings can offset a rating deficit, but never by more than their weight', () => {
    // A deliberate property of a weighted sum, worth pinning down: a busy chalet
    // with mediocre reviews CAN outrank an unproven one, because it has proven
    // real demand — but the most that demand can ever be worth is BOOKINGS_WEIGHT.
    const busyButPoor = rankingScore({ ...reviews(30, 2.5), weightedBookings: 40, globalAvgRating: 4.5 })
    const unproven = rankingScore({ globalAvgRating: 4.5 })
    assert.ok(busyButPoor > unproven, 'demand counts for something')
    assert.ok(busyButPoor - unproven < BOOKINGS_WEIGHT, 'but never for more than its weight')
    // And it cannot rescue a poor chalet past a well-reviewed, equally busy one.
    assert.ok(rankingScore({ ...reviews(30, 4.8), weightedBookings: 40, globalAvgRating: 4.5 }) > busyButPoor)
  })

  test('stays within [0, MAX_SCORE]', () => {
    const best = rankingScore({
      ...reviews(500, 5), weightedBookings: 900, globalAvgRating: 4.5, isGuestFavorite: true,
    })
    const worst = rankingScore({ ...reviews(500, 1), weightedBookings: 0, globalAvgRating: 4.5 })
    assert.ok(best <= MAX_SCORE && best > 1)
    assert.ok(worst >= 0 && worst < 0.01)
  })

  test('a strong performer outranks a listing with no history', () => {
    const proven = rankingScore({ ...reviews(80, 4.8), weightedBookings: 40, globalAvgRating: 4.5 })
    const empty = rankingScore({ globalAvgRating: 4.5 })
    assert.ok(proven > empty)
  })

  test('completed bookings lift a listing on their own', () => {
    const base = { ...reviews(10, 4.5), globalAvgRating: 4.5 }
    assert.ok(rankingScore({ ...base, weightedBookings: 30 }) > rankingScore({ ...base, weightedBookings: 3 }))
  })

  test('the guest-favourite bonus breaks ties without overturning performance', () => {
    const base = { ...reviews(10, 4.5), weightedBookings: 5, globalAvgRating: 4.5 }
    const lift = rankingScore({ ...base, isGuestFavorite: true }) - rankingScore(base)
    // A difference of two float sums, so compare within tolerance, not exactly.
    assert.ok(Math.abs(lift - FAVORITE_BONUS) < 1e-12, `got ${lift}`)
    // A favourited mediocrity must NOT beat a genuinely excellent chalet.
    const flagged = rankingScore({ ...reviews(30, 3.5), weightedBookings: 5, globalAvgRating: 4.5, isGuestFavorite: true })
    const earned = rankingScore({ ...reviews(30, 4.9), weightedBookings: 30, globalAvgRating: 4.5 })
    assert.ok(earned > flagged)
  })

  test('recency matters: the same record, older, ranks lower', () => {
    const now = rankingScore({ ...reviews(20, 4.8), weightedBookings: 20, globalAvgRating: 4.5 })
    // Three years on, every weight has decayed to the floor.
    const w = MIN_RECENCY_WEIGHT
    const stale = rankingScore({
      weightedRatingSum: 20 * 4.8 * w, weightedReviewCount: 20 * w,
      weightedBookings: 20 * w, globalAvgRating: 4.5,
    })
    assert.ok(now > stale, `${now} should exceed ${stale}`)
  })

  test('an empty input never produces NaN — a NaN would sort a listing arbitrarily', () => {
    for (const input of [{}, undefined, { weightedBookings: NaN }, { weightedRatingSum: null }]) {
      assert.ok(Number.isFinite(rankingScore(input)), `for ${JSON.stringify(input)}`)
    }
  })
})

describe('rankingBreakdown', () => {
  test('its parts add up to the score rankingScore returns', () => {
    const input = { ...reviews(12, 4.6), weightedBookings: 9, globalAvgRating: 4.4, isGuestFavorite: true }
    const b = rankingBreakdown(input)
    assert.equal(b.score, rankingScore(input))
    assert.equal(b.score, RATING_WEIGHT * b.rating + BOOKINGS_WEIGHT * b.bookings + b.favorite)
    assert.equal(b.bayesianRating, bayesianRating(input.weightedRatingSum, input.weightedReviewCount, 4.4))
  })
})

// ---- SQL twins ---------------------------------------------------------------
// No database here, so these assert the SHAPE of the generated SQL: the rules a
// silent edit would break are the ones spelled out below.

describe('sqlCompletedBooking', () => {
  const sql = sqlCompletedBooking('b')

  test('counts the two shapes of a finished stay', () => {
    assert.match(sql, /b\.status = 'completed'/)
    assert.match(sql, /b\.status = 'confirmed'/)
    assert.match(sql, /b\.check_out < now\(\)/)
  })

  test('THE HEADLINE RULE: a cancelled, rejected or pending booking is never counted', () => {
    for (const excluded of ['cancelled', 'rejected', 'pending']) {
      assert.ok(!sql.includes(excluded), `${excluded} must not appear in the completed-booking test`)
    }
  })

  test('a confirmed booking in the FUTURE is not a completed stay', () => {
    // The check_out guard is inside the confirmed branch, not ORed beside it —
    // otherwise every upcoming reservation would rank as a success.
    assert.match(sql, /\(b\.status = 'confirmed' AND b\.check_out < now\(\)\)/)
  })

  test('takes the alias so it can be spliced under any FROM', () => {
    assert.match(sqlCompletedBooking('bb'), /bb\.status/)
  })
})

describe('the SQL score', () => {
  test('ages bookings from check-out — when the stay happened, not when it was booked', () => {
    assert.match(sqlWeightedBookings('l'), /bb\.check_out/)
    assert.ok(!sqlWeightedBookings('l').includes('bb.created_at'))
  })

  test('ages reviews from when they were written', () => {
    assert.match(sqlWeightedRatingSum('l'), /rr\.created_at/)
    assert.match(sqlWeightedReviewCount('l'), /rr\.created_at/)
  })

  test('correlates every subquery to the listing being scored', () => {
    for (const sql of [sqlWeightedRatingSum('l'), sqlWeightedReviewCount('l'), sqlWeightedBookings('l')]) {
      assert.match(sql, /= l\.id/)
      assert.match(sql, /COALESCE\(/) // no listing scores NULL for having no history
    }
  })

  test('uses aliases that cannot collide with the query it is spliced into', () => {
    // getListings already joins `l` and uses `bk` for its availability check.
    const score = sqlRankingScore('l')
    assert.ok(score.includes('reviews rr'))
    assert.ok(score.includes('bookings bb'))
    assert.ok(!/\bbookings bk\b/.test(score))
  })

  test('the global average is uncorrelated, so Postgres evaluates it once', () => {
    assert.ok(!GLOBAL_AVG_RATING_SQL.includes('l.'))
    assert.match(GLOBAL_AVG_RATING_SQL, /avg\(rating\)/)
  })

  test('carries the same constants as the TypeScript twin', () => {
    const score = sqlRankingScore('l')
    assert.ok(score.includes(String(RATING_WEIGHT)))
    assert.ok(score.includes(String(BOOKINGS_WEIGHT)))
    assert.ok(score.includes(`${PRIOR_REVIEWS}.0`))
    assert.ok(score.includes(`${BOOKINGS_SATURATION}.0`))
    assert.ok(score.includes(`${FAVORITE_BONUS}`))
    assert.match(sqlRecencyWeight('x'), new RegExp(`${FULL_WEIGHT_DAYS}\\.0`))
    assert.match(sqlRecencyWeight('x'), new RegExp(`${DECAY_DAYS}\\.0`))
  })

  test('computes in float8, so Postgres does the arithmetic JS does', () => {
    assert.match(sqlAgeDays('x'), /::float8/)
    assert.match(sqlRankingScore('l'), /::float8/)
  })

  test('clamps in SQL exactly where the TypeScript clamps', () => {
    const score = sqlRankingScore('l')
    assert.match(score, /LEAST\(1\.0, GREATEST\(0\.0,/) // rating into [0,1]
    assert.match(score, /LEAST\(1\.0, ln\(/)            // bookings capped at 1
    assert.match(sqlRecencyWeight('x'), /GREATEST\(0\.25::float8/) // the decay floor
  })

  test('an age can never go negative, so no weight exceeds 1', () => {
    assert.match(sqlAgeDays('x'), /GREATEST\(/)
  })
})

describe('sqlRankingOrderBy', () => {
  const order = sqlRankingOrderBy('l')

  test('sorts by score descending', () => {
    assert.match(order, /\) DESC, l\.created_at DESC$/)
  })

  test('breaks ties on newest, so two historyless listings keep the old order', () => {
    assert.ok(order.endsWith('l.created_at DESC'))
  })

  test('is a total order — pagination must not reshuffle rows between pages', () => {
    assert.equal(order.split('DESC').length - 1, 2)
  })

  test('is built from the same expression rankingScore mirrors', () => {
    assert.ok(order.startsWith(sqlRankingScore('l')))
  })
})
