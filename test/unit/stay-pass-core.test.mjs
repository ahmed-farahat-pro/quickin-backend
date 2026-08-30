// Unit tests for `isLiveStayPass` in src/lib/local/payment-flow-core.ts — THE rule
// deciding whether a reservation has a stay pass (the QR, the Apple Wallet pass, the
// public /stay/<code> page, and the host-authored guide behind it).
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and payment-flow-core.ts has no relative imports, which is what
// makes it loadable here. See README → Testing.
//
// THE regression this file exists for: a host tapped Approve and the pass appeared
// immediately, on both the host's and the guest's screen, before the guest had
// transferred a piastre. `confirmed` means "the host accepted" — the reservation code
// is minted at that transition and payment happens AFTERWARDS — so `confirmed` alone
// must never open the pass.
//
// This file is duplicated verbatim in quickin-frontend/test/unit/. Both repos ship a
// byte-identical payment-flow-core.ts; keep both copies in step.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isLiveStayPass, PAYMENT_STATES } from '../../src/lib/local/payment-flow-core.ts'

/** A booking the host has approved, with the payment columns under test. */
const booking = (over = {}) => ({ status: 'confirmed', payment_state: 'unpaid', ...over })

describe('isLiveStayPass — the host-approved-but-unpaid hole', () => {
  test('a confirmed booking with no payment has NO pass', () => {
    assert.equal(isLiveStayPass(booking()), false)
  })

  test('a screenshot merely SUBMITTED does not open the pass', () => {
    // Money in the ops queue is not money in the account.
    assert.equal(isLiveStayPass(booking({ payment_state: 'submitted' })), false)
    assert.equal(isLiveStayPass(booking({ payment_proof_status: 'submitted' })), false)
  })

  test('a rejected or disputed payment does not open the pass', () => {
    assert.equal(isLiveStayPass(booking({ payment_state: 'rejected' })), false)
    assert.equal(isLiveStayPass(booking({ payment_state: 'disputed' })), false)
    assert.equal(isLiveStayPass(booking({ payment_proof_status: 'rejected' })), false)
    assert.equal(isLiveStayPass(booking({ payment_proof_status: 'disputed' })), false)
  })

  test('the pass opens once — and only once — the payment is approved', () => {
    assert.equal(isLiveStayPass(booking({ payment_state: 'paid' })), true)
    assert.equal(isLiveStayPass(booking({ payment_proof_status: 'approved' })), true)
    assert.equal(isLiveStayPass(booking({ paid_at: '2026-08-26T10:00:00Z' })), true)
  })
})

describe('isLiveStayPass — booking status', () => {
  test('pending never has a pass, however the payment columns read', () => {
    for (const state of PAYMENT_STATES) {
      assert.equal(isLiveStayPass({ status: 'pending', payment_state: state }), false, state)
    }
    assert.equal(isLiveStayPass({ status: 'pending', paid_at: '2026-08-26T10:00:00Z' }), false)
  })

  test('cancelled and rejected keep their code but lose the pass, even when paid', () => {
    for (const status of ['cancelled', 'rejected']) {
      assert.equal(isLiveStayPass({ status, payment_state: 'paid' }), false, status)
      assert.equal(isLiveStayPass({ status, paid_at: '2026-08-26T10:00:00Z' }), false, status)
    }
  })

  test('completed keeps its pass unconditionally — the stay happened', () => {
    // Deliberate: the pass is the guest's receipt of a stay that is over, and rows
    // predating this rule must not lose it retroactively.
    assert.equal(isLiveStayPass({ status: 'completed', payment_state: 'unpaid' }), true)
    assert.equal(isLiveStayPass({ status: 'completed', payment_state: 'paid' }), true)
  })

  test('an unknown or missing status is not a pass', () => {
    for (const status of [null, undefined, '', 'garbage']) {
      assert.equal(isLiveStayPass({ status, payment_state: 'paid' }), false, String(status))
    }
  })

  test('status is compared case- and whitespace-insensitively', () => {
    assert.equal(isLiveStayPass({ status: ' CONFIRMED ', payment_state: 'paid' }), true)
    assert.equal(isLiveStayPass({ status: 'Completed' }), true)
  })
})

describe('isLiveStayPass — column aliasing', () => {
  test('a raw bookings row (payment_status) is accepted as-is', () => {
    // BOOKING_COLS selects the column as `payment_status`; PaymentFlowBooking calls
    // it `payment_state`. Callers must not have to remember which.
    assert.equal(isLiveStayPass({ status: 'confirmed', payment_status: 'paid' }), true)
    assert.equal(isLiveStayPass({ status: 'confirmed', payment_status: 'unpaid' }), false)
  })

  test('payment_state wins when both are present', () => {
    assert.equal(
      isLiveStayPass({ status: 'confirmed', payment_state: 'unpaid', payment_status: 'paid' }),
      false
    )
  })
})
