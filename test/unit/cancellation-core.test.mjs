// Unit tests for src/lib/local/cancellation-core.ts — what a guest gets back when
// they cancel.
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and cancellation-core.ts has no relative imports, which is
// what makes it loadable here. See README → Testing.
//
// These tests pin the two decisions taken on 21 Aug 2026, both of which resolved a
// live disagreement between this API and the web:
//   1. ONE FLAT refund ladder, pending a business decision on per-listing policies.
//   2. The refund is a percentage of what the GUEST PAID, commission included.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  refundPercentForDays, refundAmountFor, isCancellable, FLAT_POLICY_LABEL,
} from '../../src/lib/local/cancellation-core.ts'

describe('refundPercentForDays — the flat ladder', () => {
  test('7 or more days before check-in refunds in full', () => {
    assert.equal(refundPercentForDays(7), 100)
    assert.equal(refundPercentForDays(30), 100)
  })

  test('1 to 6 days before check-in refunds half', () => {
    assert.equal(refundPercentForDays(6), 50)
    assert.equal(refundPercentForDays(1), 50)
  })

  test('the day of check-in, or after it, refunds nothing', () => {
    assert.equal(refundPercentForDays(0), 0)
    assert.equal(refundPercentForDays(-3), 0)
  })

  test('the boundaries are exactly 7 and 1, not 5', () => {
    // quickin-backend previously used a per-listing "moderate" ladder that paid 100%
    // from 5 days out. A stay 6 days away therefore refunded 100% on iOS and 50% on
    // the web. This asserts the single agreed answer.
    assert.equal(refundPercentForDays(6), 50)
    assert.equal(refundPercentForDays(5), 50)
  })

  test('a non-finite input refunds nothing rather than NaN', () => {
    assert.equal(refundPercentForDays(NaN), 0)
    assert.equal(refundPercentForDays(undefined), 0)
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

describe('FLAT_POLICY_LABEL', () => {
  test('reports the policy the refund maths actually honours', () => {
    // Clients show this to the guest. While the ladder is flat it must not claim a
    // per-listing policy, or the label and the number disagree.
    assert.equal(FLAT_POLICY_LABEL, 'moderate')
  })
})
