// Unit tests for src/lib/local/cancellation-core.ts — what a guest gets back when
// they cancel.
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and cancellation-core.ts has no relative imports, which is
// what makes it loadable here. See README → Testing.
//
// These tests pin the decisions taken on 21 Aug 2026:
//   1. The refund honours the host's PER-LISTING policy, read from the snapshot on
//      the booking. (This replaced a flat ladder that ignored the policy entirely.)
//   2. Nothing refunds on or after the check-in day, under ANY policy.
//   3. The refund is a percentage of what the GUEST PAID, commission included.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANCELLATION_POLICIES, normalizePolicy,
  refundPercentFor, refundAmountFor, isCancellable,
} from '../../src/lib/local/cancellation-core.ts'

describe('normalizePolicy', () => {
  test('accepts the three policies, case- and space-insensitively', () => {
    assert.equal(normalizePolicy('flexible'), 'flexible')
    assert.equal(normalizePolicy('  STRICT '), 'strict')
    assert.equal(normalizePolicy('Moderate'), 'moderate')
  })

  test('anything missing or unrecognised is moderate, not the extremes', () => {
    // Matches the database default. A listing created before the column existed, a
    // client that omits the field and a typo must all land on the middle ground —
    // never on the strictest or the most generous terms by accident.
    for (const bad of [undefined, null, '', '   ', 'nope', 'FLEXIBLE!', 42, {}]) {
      assert.equal(normalizePolicy(bad), 'moderate', `for ${JSON.stringify(bad)}`)
    }
  })

  test('the catalog is the three, in order', () => {
    assert.deepEqual(CANCELLATION_POLICIES, ['flexible', 'moderate', 'strict'])
  })
})

describe('refundPercentFor — the per-policy ladder', () => {
  test('flexible refunds in full right up to the day before', () => {
    assert.equal(refundPercentFor('flexible', 30), 100)
    assert.equal(refundPercentFor('flexible', 7), 100)
    assert.equal(refundPercentFor('flexible', 1), 100)
  })

  test('moderate refunds in full from 5 days out, half inside that', () => {
    assert.equal(refundPercentFor('moderate', 30), 100)
    assert.equal(refundPercentFor('moderate', 5), 100)
    assert.equal(refundPercentFor('moderate', 4), 50)
    assert.equal(refundPercentFor('moderate', 1), 50)
  })

  test('strict refunds half from 7 days out, nothing inside that', () => {
    assert.equal(refundPercentFor('strict', 30), 50)
    assert.equal(refundPercentFor('strict', 7), 50)
    assert.equal(refundPercentFor('strict', 6), 0)
    assert.equal(refundPercentFor('strict', 1), 0)
  })

  test('NOTHING refunds on or after the check-in day, under any policy', () => {
    // The floor is universal and deliberate. An earlier, unused draft of this ladder
    // returned 50% for moderate no matter how late — which would have paid out half a
    // stay to a guest who simply never showed up.
    for (const policy of CANCELLATION_POLICIES) {
      assert.equal(refundPercentFor(policy, 0), 0, `${policy} on the day`)
      assert.equal(refundPercentFor(policy, -3), 0, `${policy} after check-in`)
    }
  })

  test('an unknown policy is priced as moderate', () => {
    assert.equal(refundPercentFor('nonsense', 5), refundPercentFor('moderate', 5))
    assert.equal(refundPercentFor(null, 2), refundPercentFor('moderate', 2))
    assert.equal(refundPercentFor(undefined, 9), refundPercentFor('moderate', 9))
  })

  test('a non-finite day count refunds nothing rather than NaN', () => {
    assert.equal(refundPercentFor('flexible', NaN), 0)
    assert.equal(refundPercentFor('flexible', undefined), 0)
    assert.equal(refundPercentFor('moderate', 'soon'), 0)
  })

  test('no policy is ever more generous than flexible or harsher than strict', () => {
    // A cheap invariant, but it is the one that would catch a future edit that
    // accidentally inverted a comparison.
    for (const days of [-1, 0, 1, 4, 5, 6, 7, 30]) {
      const flexible = refundPercentFor('flexible', days)
      const moderate = refundPercentFor('moderate', days)
      const strict = refundPercentFor('strict', days)
      assert.ok(flexible >= moderate, `flexible < moderate at ${days} days`)
      assert.ok(moderate >= strict, `moderate < strict at ${days} days`)
    }
  })
})

describe('refundAmountFor — a share of what the guest PAID', () => {
  test('half of a commission-inclusive total', () => {
    // Host's raw price 10,000 + 10% commission = 11,000 paid by the guest.
    // Half of that is 5,500 — NOT 5,000, which is what refunding the raw price gave.
    assert.equal(refundAmountFor(11000, 50), 5500)
  })

  test('a full refund returns the whole guest-paid total', () => {
    assert.equal(refundAmountFor(11000, 100), 11000)
  })

  test('zero percent refunds nothing', () => {
    assert.equal(refundAmountFor(11000, 0), 0)
  })

  test('keeps two decimals rather than flooring to a whole unit', () => {
    // The commission-inclusive total is itself derived, so rounding down to an
    // integer here would shave a fraction off every refund, always in the
    // platform's favour.
    assert.equal(refundAmountFor(1234.57, 50), 617.29)
  })

  test('a non-finite total or percent yields 0, never NaN', () => {
    assert.equal(refundAmountFor(undefined, 50), 0)
    assert.equal(refundAmountFor(11000, undefined), 0)
  })
})

describe('isCancellable', () => {
  test('pending and confirmed bookings can be cancelled', () => {
    assert.equal(isCancellable('pending'), true)
    assert.equal(isCancellable('confirmed'), true)
  })

  test('an already-cancelled booking cannot — this blocks a double refund', () => {
    // Without this, a retried cancel request would write a second refund_amount.
    assert.equal(isCancellable('cancelled'), false)
  })

  test('any other or missing status is not cancellable', () => {
    assert.equal(isCancellable('rejected'), false)
    assert.equal(isCancellable(null), false)
    assert.equal(isCancellable(undefined), false)
  })

  test('status matching is case- and whitespace-insensitive', () => {
    assert.equal(isCancellable('  Confirmed '), true)
  })
})

