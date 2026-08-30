// Unit tests for src/lib/local/date-pricing-core.ts — the host calendar's
// per-date nightly pricing: date arithmetic, the price a host typed, and the
// ladder (custom date → weekend → month → base).
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. date-pricing-core.ts has no relative imports, which is
// what makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DATE_PRICES_TABLE,
  DEFAULT_WEEKEND_DAYS,
  MAX_DATES_PER_REQUEST,
  MAX_MONTHS_AHEAD,
  MAX_NIGHTLY_PRICE,
  MIN_NIGHTLY_PRICE,
  DatePriceError,
  addDays,
  assertWithinWindow,
  checkDayPrice,
  datePriceMap,
  dateOverrideSql,
  dayOfWeek,
  dayPriceMessage,
  daysBetween,
  expandRange,
  hasCustomNights,
  isDatePriceError,
  isIsoDate,
  monthOf,
  nightsOfStay,
  normalizeDates,
  priceNights,
  resolveNightPrice,
  sqlWithDatePrice,
  stayNightsTotal,
  applyBlockChange,
  blockRewriteWindow,
  expandBlocks,
  mergeBlockedDays,
  stayDiscountPercent, WEEKLY_DISCOUNT_MIN_NIGHTS, MONTHLY_DISCOUNT_MIN_NIGHTS,
  weekendDaysSql,
  weekendNightSql,
  perNightSeasonalSql,
} from '../../src/lib/local/date-pricing-core.ts'

// The brief's own worked example, used as the end-to-end assertion below.
const BASE = 3000
const BRIEF_PRICES = { '2026-08-16': 3500, '2026-08-17': 4000 }

describe('isIsoDate', () => {
  test('accepts a real day', () => {
    assert.equal(isIsoDate('2026-08-15'), true)
    assert.equal(isIsoDate('2024-02-29'), true) // leap year
  })

  test('rejects days that do not exist', () => {
    // A regex-only check passes all of these, and Postgres would reject them at
    // the far end of a bulk insert — after the host was told it saved.
    assert.equal(isIsoDate('2026-02-30'), false)
    assert.equal(isIsoDate('2026-13-01'), false)
    assert.equal(isIsoDate('2026-00-10'), false)
    assert.equal(isIsoDate('2026-04-31'), false)
    assert.equal(isIsoDate('2025-02-29'), false) // not a leap year
  })

  test('rejects anything that is not a strict YYYY-MM-DD string', () => {
    for (const bad of ['2026-8-15', '15/08/2026', '2026-08-15T00:00:00Z', '', ' 2026-08-15', null, undefined, 20260815, new Date()]) {
      assert.equal(isIsoDate(bad), false, `should reject ${String(bad)}`)
    }
  })
})

describe('date arithmetic', () => {
  test('addDays crosses months, years and leap days', () => {
    assert.equal(addDays('2026-08-15', 3), '2026-08-18')
    assert.equal(addDays('2026-08-31', 1), '2026-09-01')
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
    assert.equal(addDays('2026-01-01', -1), '2025-12-31')
    assert.equal(addDays('2024-02-28', 1), '2024-02-29')
    assert.equal(addDays('2025-02-28', 1), '2025-03-01')
  })

  test('addDays is DST-proof', () => {
    // Egypt reintroduced DST in 2023 (last Friday of April). A local-time
    // implementation lands on 23:00 the previous day and loses a night.
    assert.equal(addDays('2026-04-23', 1), '2026-04-24')
    assert.equal(addDays('2026-04-24', 1), '2026-04-25')
    assert.equal(addDays('2026-10-29', 1), '2026-10-30')
  })

  test('daysBetween is signed and half-open-friendly', () => {
    assert.equal(daysBetween('2026-08-15', '2026-08-18'), 3)
    assert.equal(daysBetween('2026-08-18', '2026-08-15'), -3)
    assert.equal(daysBetween('2026-08-15', '2026-08-15'), 0)
  })

  test('dayOfWeek matches Postgres extract(dow) — 0=Sun … 6=Sat', () => {
    assert.equal(dayOfWeek('2026-08-16'), 0) // Sunday
    assert.equal(dayOfWeek('2026-08-21'), 5) // Friday
    assert.equal(dayOfWeek('2026-08-22'), 6) // Saturday
  })

  test('monthOf reads the month, not the local month', () => {
    assert.equal(monthOf('2026-01-01'), 1)
    assert.equal(monthOf('2026-12-31'), 12)
  })

  test('invalid input throws a DatePriceError, not a TypeError', () => {
    assert.throws(() => addDays('nope', 1), isDatePriceError)
    assert.throws(() => dayOfWeek('2026-02-30'), isDatePriceError)
    assert.throws(() => daysBetween('2026-08-15', 'nope'), isDatePriceError)
  })
})

describe('expandRange (inclusive — a dragged calendar span)', () => {
  test('includes BOTH ends', () => {
    // The host dragged Aug 15 → Aug 18 and expects to price four days. This is
    // deliberately not the half-open range a stay uses.
    assert.deepEqual(expandRange('2026-08-15', '2026-08-18'), [
      '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18',
    ])
  })

  test('a single day is a range of one', () => {
    assert.deepEqual(expandRange('2026-08-15', '2026-08-15'), ['2026-08-15'])
  })

  test('refuses a backwards range', () => {
    assert.throws(() => expandRange('2026-08-18', '2026-08-15'), isDatePriceError)
  })

  test('refuses a range past the per-request cap', () => {
    const far = addDays('2026-01-01', MAX_DATES_PER_REQUEST)
    assert.throws(() => expandRange('2026-01-01', far), /limit is/)
    // Exactly at the cap is fine.
    assert.equal(expandRange('2026-01-01', addDays('2026-01-01', MAX_DATES_PER_REQUEST - 1)).length, MAX_DATES_PER_REQUEST)
  })
})

describe('nightsOfStay (half-open — the nights a guest pays for)', () => {
  test('excludes the checkout day', () => {
    // Aug 15 → Aug 18 is THREE nights: 15, 16, 17. Charging the 18th would bill
    // a guest for the morning they leave.
    assert.deepEqual(nightsOfStay('2026-08-15', '2026-08-18'), ['2026-08-15', '2026-08-16', '2026-08-17'])
  })

  test('an incomplete or backwards selection is empty, not an error', () => {
    assert.deepEqual(nightsOfStay('2026-08-15', '2026-08-15'), [])
    assert.deepEqual(nightsOfStay('2026-08-18', '2026-08-15'), [])
    assert.deepEqual(nightsOfStay('', '2026-08-18'), [])
    assert.deepEqual(nightsOfStay('2026-08-15', 'nope'), [])
  })
})

describe('normalizeDates', () => {
  test('sorts and de-duplicates a plain list', () => {
    assert.deepEqual(
      normalizeDates(['2026-08-17', '2026-08-15', '2026-08-17']),
      ['2026-08-15', '2026-08-17']
    )
  })

  test('accepts {start,end} spans and mixes them with single days', () => {
    assert.deepEqual(
      normalizeDates([{ start: '2026-08-15', end: '2026-08-17' }, '2026-08-20']),
      ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-20']
    )
  })

  test('overlapping spans collapse rather than double-write', () => {
    assert.deepEqual(
      normalizeDates([
        { start: '2026-08-15', end: '2026-08-17' },
        { start: '2026-08-16', end: '2026-08-18' },
      ]),
      ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18']
    )
  })

  test('THROWS on a bad date rather than dropping it', () => {
    // Dropping it silently would leave the host believing a day was priced.
    assert.throws(() => normalizeDates(['2026-08-15', '2026-02-30']), /Invalid date: 2026-02-30/)
    assert.throws(() => normalizeDates(['2026-08-15', 42]), isDatePriceError)
    assert.throws(() => normalizeDates([{ start: '2026-08-15' }]), isDatePriceError)
  })

  test('refuses an empty or non-array selection', () => {
    assert.throws(() => normalizeDates([]), /at least one date/)
    assert.throws(() => normalizeDates(null), /at least one date/)
    assert.throws(() => normalizeDates('2026-08-15'), /at least one date/)
  })
})

describe('assertWithinWindow', () => {
  const TODAY = '2026-08-21'

  test('today itself is allowed', () => {
    assert.doesNotThrow(() => assertWithinWindow([TODAY], TODAY))
  })

  test('rejects the past', () => {
    assert.throws(() => assertWithinWindow(['2026-08-20'], TODAY), /in the past/)
  })

  test('rejects beyond the horizon', () => {
    assert.throws(() => assertWithinWindow([addDays(TODAY, 3000)], TODAY), new RegExp(`${MAX_MONTHS_AHEAD} months`))
  })

  test('a year out is fine', () => {
    assert.doesNotThrow(() => assertWithinWindow([addDays(TODAY, 365)], TODAY))
  })
})

describe('checkDayPrice', () => {
  test('a typed price becomes money at piaster precision', () => {
    assert.deepEqual(checkDayPrice(3500), { ok: true, value: 3500 })
    assert.deepEqual(checkDayPrice('3500'), { ok: true, value: 3500 })
    assert.deepEqual(checkDayPrice('3500.456'), { ok: true, value: 3500.46 })
  })

  test('empty means RESET (null), which the caller turns into a delete', () => {
    for (const empty of [undefined, null, '', '   ']) {
      assert.deepEqual(checkDayPrice(empty), { ok: true, value: null }, `for ${JSON.stringify(empty)}`)
    }
  })

  test('a typed 0 is REFUSED, not read as a reset', () => {
    // 0 is a typo or a misread field. A listing that silently became free would
    // be discovered by its first booking.
    assert.deepEqual(checkDayPrice(0), { ok: false, problem: 'notPositive' })
    assert.deepEqual(checkDayPrice('0'), { ok: false, problem: 'notPositive' })
    assert.deepEqual(checkDayPrice(-200), { ok: false, problem: 'notPositive' })
  })

  test('coercible non-money is refused', () => {
    // Number(true) === 1 and Number([]) === 0 — neither is a price a host typed.
    assert.deepEqual(checkDayPrice(true), { ok: false, problem: 'notANumber' })
    assert.deepEqual(checkDayPrice([]), { ok: false, problem: 'notANumber' })
    assert.deepEqual(checkDayPrice({}), { ok: false, problem: 'notANumber' })
    assert.deepEqual(checkDayPrice('3,500'), { ok: false, problem: 'notANumber' })
    assert.deepEqual(checkDayPrice(NaN), { ok: false, problem: 'notANumber' })
    assert.deepEqual(checkDayPrice(Infinity), { ok: false, problem: 'notANumber' })
  })

  test('guards the boundaries', () => {
    assert.deepEqual(checkDayPrice(MIN_NIGHTLY_PRICE), { ok: true, value: MIN_NIGHTLY_PRICE })
    assert.deepEqual(checkDayPrice(MAX_NIGHTLY_PRICE), { ok: true, value: MAX_NIGHTLY_PRICE })
    assert.deepEqual(checkDayPrice(MAX_NIGHTLY_PRICE + 1), { ok: false, problem: 'tooLarge' })
  })

  test('every problem has a message', () => {
    for (const p of ['notANumber', 'notPositive', 'tooLarge']) {
      assert.ok(dayPriceMessage(p).length > 0)
    }
    assert.match(dayPriceMessage('tooLarge'), /or less/)
  })
})

describe('resolveNightPrice — the ladder', () => {
  // Aug 21 2026 is a Friday, Aug 22 a Saturday, Aug 16 a Sunday.
  const rules = {
    basePrice: BASE,
    weekendPrice: 3800,
    weekendDays: [5, 6],
    monthlyPrices: { 8: 3200, 12: 5000 },
    datePrices: BRIEF_PRICES,
  }

  test('a pinned date beats the weekend rate', () => {
    const custom = resolveNightPrice('2026-08-21', { ...rules, datePrices: { '2026-08-21': 9999 } })
    assert.deepEqual(custom, { date: '2026-08-21', price: 9999, source: 'custom' })
  })

  test('a pinned date beats the month rate', () => {
    assert.deepEqual(resolveNightPrice('2026-08-16', rules), { date: '2026-08-16', price: 3500, source: 'custom' })
  })

  test('the weekend rate beats the month rate', () => {
    assert.deepEqual(resolveNightPrice('2026-08-21', rules), { date: '2026-08-21', price: 3800, source: 'weekend' })
  })

  test('the month rate beats the base', () => {
    assert.deepEqual(resolveNightPrice('2026-08-19', rules), { date: '2026-08-19', price: 3200, source: 'monthly' })
  })

  test('the base is the floor', () => {
    const bare = { basePrice: BASE }
    assert.deepEqual(resolveNightPrice('2026-08-19', bare), { date: '2026-08-19', price: BASE, source: 'base' })
  })

  test('weekendDays is honoured, and defaults to Fri+Sat', () => {
    const sundayWeekend = { basePrice: BASE, weekendPrice: 3800, weekendDays: [0] }
    assert.equal(resolveNightPrice('2026-08-16', sundayWeekend).source, 'weekend') // Sunday
    assert.equal(resolveNightPrice('2026-08-21', sundayWeekend).source, 'base')    // Friday

    const noDays = { basePrice: BASE, weekendPrice: 3800 }
    assert.equal(resolveNightPrice('2026-08-21', noDays).source, 'weekend')
    assert.deepEqual([...DEFAULT_WEEKEND_DAYS], [5, 6])
  })

  test('an empty weekendDays array falls back to the default rather than disabling the rung', () => {
    const empty = { basePrice: BASE, weekendPrice: 3800, weekendDays: [] }
    assert.equal(resolveNightPrice('2026-08-21', empty).source, 'weekend')
  })

  test('junk at any rung falls through instead of pricing a night at NaN', () => {
    const junk = {
      basePrice: BASE,
      weekendPrice: 'abc',
      monthlyPrices: { 8: '', 9: null, 10: 0, 11: -5 },
      datePrices: { '2026-08-19': 'not a price' },
    }
    assert.deepEqual(resolveNightPrice('2026-08-19', junk), { date: '2026-08-19', price: BASE, source: 'base' })
    assert.deepEqual(resolveNightPrice('2026-09-19', junk), { date: '2026-09-19', price: BASE, source: 'base' })
  })

  test('a month key works as "8" or 8 — jsonb hands back strings', () => {
    const strKeys = { basePrice: BASE, monthlyPrices: { '8': 3200 } }
    assert.equal(resolveNightPrice('2026-08-19', strKeys).price, 3200)
  })

  test('a missing base price is 0, never NaN', () => {
    assert.equal(resolveNightPrice('2026-08-19', { basePrice: undefined }).price, 0)
    assert.equal(resolveNightPrice('2026-08-19', { basePrice: 'oops' }).price, 0)
  })
})

describe('the brief’s worked example', () => {
  test('Aug 15–18 with two pinned nights totals 10,500 for three nights', () => {
    // Base 3,000. Aug 15 = 3,000 (base), 16 = 3,500, 17 = 4,000. Aug 18 is the
    // CHECKOUT day and is not a night — the brief's 13,500 counts four nights,
    // which would be a 15→19 stay.
    const nights = priceNights('2026-08-15', '2026-08-18', { basePrice: BASE, datePrices: BRIEF_PRICES })
    assert.deepEqual(nights.map((n) => n.price), [3000, 3500, 4000])
    assert.equal(stayNightsTotal(nights), 10_500)
    assert.equal(hasCustomNights(nights), true)
  })

  test('staying through Aug 19 charges all four days and totals 13,500', () => {
    const nights = priceNights('2026-08-15', '2026-08-19', {
      basePrice: BASE,
      datePrices: { ...BRIEF_PRICES, '2026-08-18': 3000 },
    })
    assert.deepEqual(nights.map((n) => n.price), [3000, 3500, 4000, 3000])
    assert.equal(stayNightsTotal(nights), 13_500)
  })

  test('with no pinned nights the stay is nights × base', () => {
    const nights = priceNights('2026-08-15', '2026-08-18', { basePrice: BASE })
    assert.equal(stayNightsTotal(nights), 9000)
    assert.equal(hasCustomNights(nights), false)
  })

  test('an empty stay totals 0', () => {
    assert.equal(stayNightsTotal(priceNights('2026-08-15', '2026-08-15', { basePrice: BASE })), 0)
  })
})

describe('datePriceMap', () => {
  test('turns rows into the map the ladder wants', () => {
    assert.deepEqual(
      datePriceMap([{ date: '2026-08-16', price: '3500' }, { date: '2026-08-17', price: 4000 }]),
      { '2026-08-16': 3500, '2026-08-17': 4000 }
    )
  })

  test('drops junk rows rather than poisoning the map', () => {
    // pg hands numerics back as strings; a NULL or a bad date must not become a
    // NaN entry that then beats every other rung.
    assert.deepEqual(
      datePriceMap([
        { date: '2026-08-16', price: null },
        { date: '2026-02-30', price: 3500 },
        { date: 'nope', price: 3500 },
        { date: '2026-08-17', price: 0 },
      ]),
      {}
    )
  })

  test('null and undefined are an empty map', () => {
    assert.deepEqual(datePriceMap(null), {})
    assert.deepEqual(datePriceMap(undefined), {})
  })
})

describe('SQL builders', () => {
  test('dateOverrideSql reads the pinned price for the day in scope', () => {
    const sql = dateOverrideSql('d')
    assert.match(sql, new RegExp(DATE_PRICES_TABLE))
    assert.match(sql, /dp\.listing_id = l\.id/)
    assert.match(sql, /dp\.date = \(d\)::date/)
  })

  test('the listing expression is overridable for queries with another alias', () => {
    assert.match(dateOverrideSql('gs', 'li.id'), /dp\.listing_id = li\.id/)
  })

  test('sqlWithDatePrice puts the date rung on top of an existing ladder', () => {
    const sql = sqlWithDatePrice('d', 'l.price_per_night')
    assert.match(sql, /^COALESCE\(\(SELECT dp\.price/)
    assert.match(sql, /l\.price_per_night/)
    // The fallback is parenthesised — a bare CASE…END spliced into COALESCE
    // without its own parens would still parse, but a comma-containing
    // expression would silently become a second COALESCE argument.
    assert.match(sql, /, \(l\.price_per_night\)\)$/)
  })

  test('a CASE fallback survives the wrap', () => {
    const ladder = `CASE WHEN extract(dow from d)::int IN (5, 6) THEN l.weekend_price ELSE l.price_per_night END`
    const sql = sqlWithDatePrice('d', ladder)
    assert.ok(sql.includes(ladder))
    assert.equal((sql.match(/COALESCE/g) || []).length, 1)
  })
})

// The weekend rung reads a per-listing day set, and the whole reason these two
// helpers are exported is that the PRICE and the LABEL are built by different
// queries. They used to be written out twice, and the second copy hardcoded
// Fri/Sat — so a host with a Thu+Fri weekend was charged the weekend rate and
// told the night was 'base'.
describe('SQL builders — which nights are the weekend', () => {
  test('weekendDaysSql falls back to the default for NULL and for an empty set', () => {
    const sql = weekendDaysSql()
    // NULLIF first, so `{}` (a row predating the write rules) is treated as
    // "never chose" rather than as "no day is a weekend".
    assert.match(sql, /NULLIF\(l\.weekend_days, '\{\}'\)/)
    assert.ok(sql.includes(`ARRAY[${DEFAULT_WEEKEND_DAYS.join(', ')}]`))
  })

  test('weekendDaysSql honours another table alias', () => {
    assert.match(weekendDaysSql('li'), /NULLIF\(li\.weekend_days/)
    assert.ok(!weekendDaysSql('li').includes('l.weekend_days'))
  })

  test('weekendNightSql needs BOTH a rate and a matching day', () => {
    const sql = weekendNightSql('d')
    // Without the rate check, a listing with no weekend price would label every
    // Friday 'weekend' while being charged the base rate.
    assert.match(sql, /l\.weekend_price IS NOT NULL/)
    assert.match(sql, /EXTRACT\(DOW FROM \(d\)\)::int = ANY\(/)
  })

  test('weekendNightSql asks the listing which days those are, never Fri\/Sat directly', () => {
    const sql = weekendNightSql('d')
    assert.ok(sql.includes(weekendDaysSql('l')))
    // The literal the two hardcoded CASEs used to carry. It may only appear
    // inside the ARRAY[...] fallback, never as a bare dow comparison.
    assert.ok(!/IN \(5, 6\)/.test(sql))
  })

  test('the price rung and the label are built from the same expression', () => {
    // perNightSeasonalSql is the price; weekendNightSql is what the calendar and
    // the stay quote label with. If these ever stop overlapping, a host sees a
    // badge that contradicts the number beside it.
    assert.ok(perNightSeasonalSql('d').includes(weekendNightSql('d', 'l')))
  })
})

describe('errors', () => {
  test('isDatePriceError is cross-realm safe', () => {
    assert.equal(isDatePriceError(new DatePriceError('x')), true)
    // A structurally identical error from another bundle must still match.
    const foreign = new Error('x')
    foreign.name = 'DatePriceError'
    assert.equal(isDatePriceError(foreign), true)
    assert.equal(isDatePriceError(new Error('x')), false)
    assert.equal(isDatePriceError('DatePriceError'), false)
    assert.equal(isDatePriceError(null), false)
  })
})

describe('blocked-day spans', () => {
  // Availability is stored as half-open [start, end) ranges, but the calendar
  // edits single days — these helpers are the round trip between the two.
  const MAINTENANCE = { id: 'b1', start: '2026-08-10', end: '2026-08-15', note: 'maintenance' }

  test('expandBlocks explodes a span into its days, excluding `end`', () => {
    const days = expandBlocks([MAINTENANCE])
    assert.deepEqual([...days.keys()], ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'])
    assert.equal(days.get('2026-08-14'), 'maintenance')
    assert.equal(days.has('2026-08-15'), false)
  })

  test('expandBlocks skips corrupt rows instead of throwing or allocating forever', () => {
    assert.equal(expandBlocks([{ start: '2026-08-15', end: '2026-08-15' }]).size, 0) // zero-length
    assert.equal(expandBlocks([{ start: '2026-08-15', end: '2026-08-10' }]).size, 0) // backwards
    assert.equal(expandBlocks([{ start: 'nope', end: '2026-08-15' }]).size, 0)
    assert.equal(expandBlocks([{ start: '2026-08-15', end: '2126-08-15' }]).size, 0) // absurd
    assert.equal(expandBlocks([null, undefined]).size, 0)
  })

  test('mergeBlockedDays collapses consecutive days into one half-open span', () => {
    const days = new Map([['2026-08-10', ''], ['2026-08-11', ''], ['2026-08-12', '']])
    assert.deepEqual(mergeBlockedDays(days), [{ start: '2026-08-10', end: '2026-08-13', note: null }])
  })

  test('a gap starts a new span', () => {
    const days = new Map([['2026-08-10', ''], ['2026-08-12', '']])
    assert.deepEqual(mergeBlockedDays(days), [
      { start: '2026-08-10', end: '2026-08-11', note: null },
      { start: '2026-08-12', end: '2026-08-13', note: null },
    ])
  })

  test('differing notes do not merge, even when the days are consecutive', () => {
    const days = new Map([['2026-08-10', 'paint'], ['2026-08-11', 'family']])
    assert.deepEqual(mergeBlockedDays(days), [
      { start: '2026-08-10', end: '2026-08-11', note: 'paint' },
      { start: '2026-08-11', end: '2026-08-12', note: 'family' },
    ])
  })

  test('a round trip through expand → merge is lossless', () => {
    assert.deepEqual(mergeBlockedDays(expandBlocks([MAINTENANCE])), [
      { start: '2026-08-10', end: '2026-08-15', note: 'maintenance' },
    ])
  })

  test('unblocking the MIDDLE of a span splits it, keeping the note on both halves', () => {
    // The whole reason these helpers exist: the range table cannot express this
    // edit, and a naive delete would open five days instead of one.
    assert.deepEqual(applyBlockChange([MAINTENANCE], ['2026-08-12'], false), [
      { start: '2026-08-10', end: '2026-08-12', note: 'maintenance' },
      { start: '2026-08-13', end: '2026-08-15', note: 'maintenance' },
    ])
  })

  test('unblocking an end trims rather than splits', () => {
    assert.deepEqual(applyBlockChange([MAINTENANCE], ['2026-08-10'], false), [
      { start: '2026-08-11', end: '2026-08-15', note: 'maintenance' },
    ])
    assert.deepEqual(applyBlockChange([MAINTENANCE], ['2026-08-14'], false), [
      { start: '2026-08-10', end: '2026-08-14', note: 'maintenance' },
    ])
  })

  test('unblocking every day leaves nothing', () => {
    assert.deepEqual(applyBlockChange([MAINTENANCE], expandRange('2026-08-10', '2026-08-14'), false), [])
  })

  test('blocking days adjacent to a span extends it instead of adding a second row', () => {
    assert.deepEqual(applyBlockChange([MAINTENANCE], ['2026-08-15'], true, 'maintenance'), [
      { start: '2026-08-10', end: '2026-08-16', note: 'maintenance' },
    ])
  })

  test('blocking a day that is ALREADY blocked keeps its existing note', () => {
    // The host is confirming a state, not relabelling a block they may not have
    // been looking at.
    assert.deepEqual(applyBlockChange([MAINTENANCE], ['2026-08-12'], true, 'something else'), [
      { start: '2026-08-10', end: '2026-08-15', note: 'maintenance' },
    ])
  })

  test('blocking scattered days produces one span each', () => {
    assert.deepEqual(applyBlockChange([], ['2026-08-20', '2026-08-22'], true, null), [
      { start: '2026-08-20', end: '2026-08-21', note: null },
      { start: '2026-08-22', end: '2026-08-23', note: null },
    ])
  })

  test('unblocking a day that was never blocked is a no-op, not an error', () => {
    assert.deepEqual(applyBlockChange([MAINTENANCE], ['2026-09-01'], false), [
      { start: '2026-08-10', end: '2026-08-15', note: 'maintenance' },
    ])
  })

  test('an invalid date in the selection is ignored rather than corrupting the rewrite', () => {
    assert.deepEqual(applyBlockChange([MAINTENANCE], ['2026-02-30'], false), [
      { start: '2026-08-10', end: '2026-08-15', note: 'maintenance' },
    ])
  })
})

describe('blockRewriteWindow', () => {
  const MAINTENANCE = { id: 'b1', start: '2026-08-10', end: '2026-08-15', note: 'maintenance' }

  test('widens to swallow any overlapping span whole', () => {
    // Without this, unblocking Aug 12 would rewrite only Aug 12 and the other
    // four days of the span would silently open up.
    assert.deepEqual(blockRewriteWindow([MAINTENANCE], ['2026-08-12']), { from: '2026-08-10', to: '2026-08-14' })
  })

  test('leaves a non-overlapping selection alone', () => {
    assert.deepEqual(blockRewriteWindow([MAINTENANCE], ['2026-09-01']), { from: '2026-09-01', to: '2026-09-01' })
  })

  test('a span touching only the last day still widens the window', () => {
    // end is exclusive, so this span's last blocked day is Aug 14.
    assert.deepEqual(blockRewriteWindow([MAINTENANCE], ['2026-08-14', '2026-08-20']), { from: '2026-08-10', to: '2026-08-20' })
  })

  test('a span ending exactly at the selection does NOT widen it', () => {
    const before = { start: '2026-08-01', end: '2026-08-10', note: null }
    assert.deepEqual(blockRewriteWindow([before], ['2026-08-10']), { from: '2026-08-10', to: '2026-08-10' })
  })

  test('nothing selected is nothing to do', () => {
    assert.equal(blockRewriteWindow([MAINTENANCE], []), null)
    assert.equal(blockRewriteWindow([MAINTENANCE], ['nope']), null)
  })
})

describe('stayDiscountPercent — the length-of-stay discount', () => {
  test('short stays get nothing', () => {
    assert.equal(stayDiscountPercent(1, 10, 25), 0)
    assert.equal(stayDiscountPercent(6, 10, 25), 0)
  })

  test('the weekly rate starts at exactly 7 nights', () => {
    assert.equal(WEEKLY_DISCOUNT_MIN_NIGHTS, 7)
    assert.equal(stayDiscountPercent(7, 10, 25), 10)
    assert.equal(stayDiscountPercent(27, 10, 25), 10)
  })

  test('the monthly rate takes over at exactly 28 nights and does NOT compound', () => {
    // 25, not 35 — the longer discount supersedes the weekly one rather than
    // stacking with it.
    assert.equal(MONTHLY_DISCOUNT_MIN_NIGHTS, 28)
    assert.equal(stayDiscountPercent(28, 10, 25), 25)
  })

  test('a missing rate for the bracket means no discount', () => {
    // A host who set only a monthly rate gives nothing away on a 10-night stay.
    assert.equal(stayDiscountPercent(10, null, 25), 0)
    assert.equal(stayDiscountPercent(30, 10, null), 0)
  })

  test('a discount over 100% is clamped, never inverted', () => {
    // Otherwise the stay total goes negative and the platform pays the guest.
    assert.equal(stayDiscountPercent(30, 0, 150), 100)
  })

  test('nonsense inputs discount nothing rather than producing NaN', () => {
    assert.equal(stayDiscountPercent(0, 10, 25), 0)
    assert.equal(stayDiscountPercent(NaN, 10, 25), 0)
    assert.equal(stayDiscountPercent(10, undefined, undefined), 0)
  })
})
