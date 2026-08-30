// Unit tests for src/lib/local/host-retention-core.ts — what a host KEEPS when a
// booking is cancelled.
//
// Offline: no database, no network. Run with `npm test`. The explicit `.ts`
// extension is required — Node strips types but its ESM resolver needs it, and
// host-retention-core.ts has no relative imports, which is what makes it loadable
// here. See README → Testing.
//
// These pin the bug this module was written for: getHostEarnings carried a blanket
// `b.status <> 'cancelled'`, so a cancellation under a no-refund policy deducted
// 100% of the host's money even though the guest was refunded nothing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRefundable, normalizeRefundPercent, retainedFraction, retainedAmount,
  isFullyRefunded, sqlRefundPercent, sqlRetainedFraction, sqlRetained,
  sqlHasRetainedValue,
} from '../../src/lib/local/host-retention-core.ts'

describe('isRefundable', () => {
  test('only cancelled bookings take a refund haircut', () => {
    assert.equal(isRefundable('cancelled'), true)
    assert.equal(isRefundable(' CANCELLED '), true)
    for (const s of ['pending', 'confirmed', 'completed', 'rejected']) {
      assert.equal(isRefundable(s), false, s)
    }
  })

  test('missing status is not a cancellation', () => {
    // A row with no status must not silently lose the host their money.
    assert.equal(isRefundable(null), false)
    assert.equal(isRefundable(undefined), false)
    assert.equal(isRefundable(''), false)
  })
})

describe('normalizeRefundPercent', () => {
  test('NULL reads as 0 — no refund, host keeps the money', () => {
    // The decision that matters most here. admin.ts cancels without writing a
    // refund_percent, and no cancellation taken before the column existed has one.
    // Reading those as full refunds would confiscate host earnings on every /ops
    // cancellation. 0 also matches what the /ops reports already show for them.
    assert.equal(normalizeRefundPercent(null), 0)
    assert.equal(normalizeRefundPercent(undefined), 0)
    assert.equal(normalizeRefundPercent(''), 0)
    assert.equal(normalizeRefundPercent('not a number'), 0)
  })

  test('clamps to 0–100 and accepts numeric strings from pg', () => {
    assert.equal(normalizeRefundPercent(-20), 0)
    assert.equal(normalizeRefundPercent(150), 100)
    assert.equal(normalizeRefundPercent('50'), 50)
    assert.equal(normalizeRefundPercent(37.5), 37.5)
  })
})

describe('retainedFraction', () => {
  test('a booking that is not cancelled is worth all of itself', () => {
    assert.equal(retainedFraction('confirmed', 0), 1)
    assert.equal(retainedFraction('completed', null), 1)
    // Even a stray refund_percent on a live booking changes nothing — only a
    // cancellation reduces the money.
    assert.equal(retainedFraction('confirmed', 50), 1)
  })

  test('THE BUG: a no-refund cancellation leaves the host whole', () => {
    assert.equal(retainedFraction('cancelled', 0), 1)
    assert.equal(retainedFraction('cancelled', null), 1)
  })

  test('a partial refund is proportional, a full one leaves nothing', () => {
    assert.equal(retainedFraction('cancelled', 50), 0.5)
    assert.equal(retainedFraction('cancelled', 100), 0)
  })
})

describe('retainedAmount', () => {
  test('the reported scenario: cancelled, nothing refunded, full earnings kept', () => {
    assert.equal(retainedAmount(10_000, 'cancelled', 0), 10_000)
  })

  test('the moderate-policy 50% case splits host and commission alike', () => {
    // Guest paid 11,000 (10,000 host + 10% markup) and is refunded 5,500. What is
    // left is 5,000 for the host and 500 for the platform — the platform does not
    // keep a whole commission on half a stay, and the host does not absorb it all.
    assert.equal(retainedAmount(10_000, 'cancelled', 50), 5_000)
    assert.equal(retainedAmount(11_000, 'cancelled', 50), 5_500)
  })

  test('rounds rather than floors, so the odd pound is not shaved off the host', () => {
    assert.equal(retainedAmount(999, 'cancelled', 50), 500)
  })

  test('non-positive and non-numeric amounts are 0, never NaN', () => {
    for (const bad of [0, -1, null, undefined, 'abc', NaN]) {
      assert.equal(retainedAmount(bad, 'cancelled', 0), 0, String(bad))
    }
  })
})

describe('isFullyRefunded', () => {
  test('only a 100% refund on a cancellation hides the row', () => {
    assert.equal(isFullyRefunded('cancelled', 100), true)
    assert.equal(isFullyRefunded('cancelled', 99), false)
    assert.equal(isFullyRefunded('cancelled', 0), false)
    // A live booking is never "fully refunded", whatever the column says.
    assert.equal(isFullyRefunded('confirmed', 100), false)
  })
})

describe('SQL builders agree with the JS above', () => {
  test('they honour the alias they are given', () => {
    assert.match(sqlRefundPercent('bk'), /bk\.refund_percent/)
    assert.match(sqlRetainedFraction('bk'), /bk\.status/)
    assert.match(sqlHasRetainedValue('bk'), /bk\.status/)
    // Default alias is the `b` every query in db.ts / money.ts / analytics.ts uses.
    assert.match(sqlRefundPercent(), /\bb\.refund_percent/)
  })

  test('the fraction is 1 for anything not cancelled and NULL-safe', () => {
    const sql = sqlRetainedFraction()
    assert.match(sql, /ELSE 1 END/)
    assert.match(sql, /COALESCE\(b\.refund_percent, 0\)/)
    // /100.0, not /100 — integer division in Postgres would round every partial
    // refund down to a 0 or 1 fraction.
    assert.match(sql, /100\.0/)
  })

  test('sqlRetained wraps the caller expression rather than assuming a column', () => {
    // money.ts passes a commission-inclusive expression through this, which is how
    // the guest-facing total and the host's price shrink by the same fraction.
    const sql = sqlRetained('(b.total_price * 1.1)')
    assert.ok(sql.includes('(b.total_price * 1.1)'))
    assert.ok(sql.includes(sqlRetainedFraction()))
  })

  test('sqlHasRetainedValue keeps partial cancellations, drops the empty ones', () => {
    const sql = sqlHasRetainedValue()
    assert.match(sql, /b\.status <> 'cancelled'/)
    assert.match(sql, /< 100/)
  })
})
