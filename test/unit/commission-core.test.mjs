// Unit tests for src/lib/local/commission-core.ts — the platform commission that
// turns a host's raw price into the price a guest is quoted.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. commission-core.ts has no relative imports, which is what
// makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMISSION_RATE_KEY,
  COMMISSION_RATE_SQL,
  DEFAULT_COMMISSION_RATE,
  MAX_COMMISSION_PERCENT,
  ROUNDING_STEP,
  commissionAmount,
  isCommissionError,
  monthlyPricesWithCommission,
  parseRate,
  percentFromRate,
  rateFromPercent,
  rateToStored,
  roundUpToStep,
  sqlWithCommission,
  stripCommission,
  withCommission,
} from '../../src/lib/local/commission-core.ts'

describe('COMMISSION_RATE_KEY', () => {
  test('is the app_settings row migrate-analytics seeded', () => {
    assert.equal(COMMISSION_RATE_KEY, 'platform_commission_rate')
  })
})

describe('parseRate', () => {
  test('reads a stored fraction', () => {
    assert.equal(parseRate('0.1'), 0.1)
    assert.equal(parseRate('0.155'), 0.155)
    assert.equal(parseRate('0'), 0)
  })

  test('falls back rather than throwing — a bad row must not break the listings feed', () => {
    for (const bad of [null, undefined, '', '  ', 'abc', '-0.2', {}, []]) {
      assert.equal(parseRate(bad), DEFAULT_COMMISSION_RATE, `for ${JSON.stringify(bad)}`)
    }
  })

  test('rejects a rate above 100%, which would be a misplaced decimal', () => {
    // Someone storing "10" meaning 10% would otherwise mark every price up 11×.
    assert.equal(parseRate('10'), DEFAULT_COMMISSION_RATE)
    assert.equal(parseRate('1'), 1) // exactly 100% is allowed
  })
})

describe('rateFromPercent', () => {
  test('converts what the admin typed into the stored fraction', () => {
    assert.equal(rateFromPercent(10), 0.1)
    assert.equal(rateFromPercent('12.5'), 0.125)
    assert.equal(rateFromPercent(0), 0)
    assert.equal(rateFromPercent(100), 1)
  })

  test('throws on input a human should fix, instead of silently ignoring it', () => {
    for (const bad of ['', '   ', null, undefined, 'abc', -1, 101, Infinity, NaN]) {
      assert.throws(() => rateFromPercent(bad), isCommissionError, `for ${JSON.stringify(bad)}`)
    }
  })

  test('round-trips through the stored string at the precision the column holds', () => {
    // bookings.commission_rate is numeric(5,4), so 2 decimals of a percent.
    for (const percent of [0, 7.5, 10, 12.34, 100]) {
      const rate = rateFromPercent(percent)
      assert.equal(percentFromRate(rate), percent)
      assert.equal(parseRate(rateToStored(rate)), rate)
    }
  })

  test('MAX_COMMISSION_PERCENT is the documented ceiling', () => {
    assert.equal(MAX_COMMISSION_PERCENT, 100)
  })
})

describe('roundUpToStep', () => {
  test('rounds up to the nearest 10 and leaves exact multiples alone', () => {
    assert.equal(ROUNDING_STEP, 10)
    assert.equal(roundUpToStep(100), 100)
    assert.equal(roundUpToStep(101), 110)
    assert.equal(roundUpToStep(109.01), 110)
  })

  test('does not overshoot on binary-float dust', () => {
    // 100 * 1.1 === 110.00000000000001 in IEEE754. A naive ceil gives 120.
    assert.equal(roundUpToStep(100 * 1.1), 110)
    assert.equal(roundUpToStep(2000 * 1.15), 2300)
    assert.equal(roundUpToStep(700 * 1.3), 910)
  })

  test('floors at zero', () => {
    assert.equal(roundUpToStep(0), 0)
    assert.equal(roundUpToStep(-5), 0)
    assert.equal(roundUpToStep(NaN), 0)
  })
})

describe('withCommission', () => {
  test('marks a raw price up and lands it on a multiple of 10', () => {
    assert.equal(withCommission(5000, 0.1), 5500)
    assert.equal(withCommission(5472, 0.1), 6020)
    assert.equal(withCommission(2199, 0.15), 2530)
  })

  test('a zero rate leaves the price alone (bar the rounding step)', () => {
    assert.equal(withCommission(5000, 0), 5000)
    assert.equal(withCommission(5001, 0), 5010)
  })

  test('passes null through — a listing with no weekend price must not gain one', () => {
    assert.equal(withCommission(null, 0.1), null)
    assert.equal(withCommission(undefined, 0.1), null)
  })

  test('treats junk and non-positive input as zero', () => {
    assert.equal(withCommission(0, 0.1), 0)
    assert.equal(withCommission(-100, 0.1), 0)
    assert.equal(withCommission(NaN, 0.1), 0)
  })

  test('never returns less than the host is owed', () => {
    // The invariant the whole feature rests on: the guest price covers the raw
    // price at every rate, so a payout can never exceed what was collected.
    for (const raw of [1, 99, 100, 1234, 5472, 99_999]) {
      for (const rate of [0, 0.05, 0.1, 0.125, 0.5, 1]) {
        assert.ok(withCommission(raw, rate) >= raw, `raw=${raw} rate=${rate}`)
      }
    }
  })
})

describe('monthlyPricesWithCommission', () => {
  test('marks up every month in the jsonb map', () => {
    assert.deepEqual(monthlyPricesWithCommission({ 7: 5000, 8: 6000 }, 0.1), { 7: 5500, 8: 6600 })
  })

  test('drops junk entries rather than emitting NaN', () => {
    assert.deepEqual(monthlyPricesWithCommission({ 7: 5000, 8: 'abc', 9: 0, 10: -1 }, 0.1), { 7: 5500 })
  })

  test('handles an absent or empty map', () => {
    assert.deepEqual(monthlyPricesWithCommission(null, 0.1), {})
    assert.deepEqual(monthlyPricesWithCommission({}, 0.1), {})
  })
})

describe('stripCommission and commissionAmount', () => {
  test('stripCommission approximately inverts the markup', () => {
    assert.equal(stripCommission(5500, 0.1), 5000)
    assert.equal(stripCommission(0, 0.1), 0)
  })

  test('commissionAmount is the platform cut in EGP', () => {
    assert.equal(commissionAmount(5000, 0.1), 500)
    assert.equal(commissionAmount(5000, 0), 0)
  })
})

describe('SQL builders', () => {
  test('the rate subquery reads the same key, with the same fallback', () => {
    assert.match(COMMISSION_RATE_SQL, /platform_commission_rate/)
    assert.match(COMMISSION_RATE_SQL, new RegExp(String(DEFAULT_COMMISSION_RATE)))
  })

  test('sqlWithCommission applies markup then the same round-up step', () => {
    const sql = sqlWithCommission('l.price_per_night')
    assert.match(sql, /l\.price_per_night/)
    assert.match(sql, /ceil/)
    assert.match(sql, new RegExp(`/ ${ROUNDING_STEP}\\.0\\) \\* ${ROUNDING_STEP}`))
  })

  test('accepts a caller-supplied rate expression, for a booking-snapshot rate', () => {
    assert.match(sqlWithCommission('b.total_price', 'b.commission_rate'), /b\.commission_rate/)
  })
})
