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
  refundOutcomeFor, isRefundDue, REFUND_OUTCOMES,
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


// The reported defect: **a cancelled reservation did not say what happened to the
// money.** A guest who cancelled 10 days out and got everything back, one who
// cancelled 2 days out and got half, and one who cancelled on the morning of
// check-in and got nothing all read "Cancelled" — on their own screen and on the
// host's. refundOutcomeFor is the one rule the iOS and Android badges now run
// (CancellationOutcome.swift / CancellationOutcome.kt are its twins).
describe('refundOutcomeFor', () => {
  const paid = { status: 'cancelled', payment_status: 'paid' }

  test('a booking that is not cancelled has no outcome to show', () => {
    for (const status of ['pending', 'confirmed', 'completed', 'rejected', null, undefined]) {
      assert.equal(refundOutcomeFor({ status, refund_percent: 100, payment_status: 'paid' }), 'open')
    }
  })

  test('100% back reads as refunded, anything between as partially refunded', () => {
    assert.equal(refundOutcomeFor({ ...paid, refund_percent: 100 }), 'refunded')
    assert.equal(refundOutcomeFor({ ...paid, refund_percent: 50 }), 'partially_refunded')
    assert.equal(refundOutcomeFor({ ...paid, refund_percent: 1 }), 'partially_refunded')
    assert.equal(refundOutcomeFor({ ...paid, refund_percent: 99 }), 'partially_refunded')
  })

  test('nothing back reads as a plain cancellation', () => {
    // The day-of-check-in floor, and strict inside 7 days.
    assert.equal(refundOutcomeFor({ ...paid, refund_percent: 0 }), 'cancelled')
  })

  test('an UNPAID cancellation is plain "cancelled", whatever the ladder quoted', () => {
    // The ladder quotes a percentage for every cancellation, paid or not. Most
    // cancellations are pending requests called off before any transfer — telling
    // that guest they were "Refunded" claims money came back that was never taken.
    assert.equal(refundOutcomeFor({ status: 'cancelled', refund_percent: 100 }), 'cancelled')
    assert.equal(
      refundOutcomeFor({ status: 'cancelled', refund_percent: 100, payment_status: 'unpaid' }),
      'cancelled'
    )
    assert.equal(
      refundOutcomeFor({ status: 'cancelled', refund_percent: 50, payment_status: 'submitted' }),
      'cancelled'
    )
  })

  test('paid_at alone proves payment — payment_status may be a legacy value', () => {
    assert.equal(
      refundOutcomeFor({ status: 'cancelled', refund_percent: 100, paid_at: '2026-08-01T00:00:00Z' }),
      'refunded'
    )
  })

  test('a missing refund_percent is no refund, never an invented one', () => {
    // Admin cancellations and rows written before the column existed. Guessing here
    // is the one mistake with a cash cost.
    for (const pct of [null, undefined, NaN, 'abc']) {
      assert.equal(refundOutcomeFor({ ...paid, refund_percent: pct }), 'cancelled', `for ${String(pct)}`)
    }
  })

  test('status matching is case- and whitespace-insensitive', () => {
    assert.equal(refundOutcomeFor({ status: ' Cancelled ', refund_percent: 100, payment_status: 'PAID' }), 'refunded')
  })

  test('the vocabulary is the four the clients switch on', () => {
    assert.deepEqual(REFUND_OUTCOMES, ['open', 'cancelled', 'partially_refunded', 'refunded'])
  })
})

// The /ops queue's membership test. There is no gateway: a human transfers the
// money and marks the row, so "owed" and "sent" are two different facts.
describe('isRefundDue', () => {
  const owed = { status: 'cancelled', refund_percent: 50, payment_status: 'paid' }

  test('cancelled, earned and paid but not yet sent is due', () => {
    assert.equal(isRefundDue(owed), true)
    assert.equal(isRefundDue({ ...owed, refund_percent: 100 }), true)
  })

  test('once settled it is no longer due', () => {
    assert.equal(isRefundDue({ ...owed, refunded_at: '2026-08-26T10:00:00Z' }), false)
  })

  test('nothing is due when nothing was earned or nothing was paid', () => {
    assert.equal(isRefundDue({ ...owed, refund_percent: 0 }), false)
    assert.equal(isRefundDue({ ...owed, payment_status: 'unpaid', paid_at: null }), false)
  })

  test('a live booking is never due — only a cancellation can owe a refund', () => {
    assert.equal(isRefundDue({ ...owed, status: 'confirmed' }), false)
  })
})
