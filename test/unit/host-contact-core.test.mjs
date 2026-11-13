// Unit tests for src/lib/local/host-contact-core.ts — when a guest's booking
// carries the host's phone number (BOOKING_COLS → `host_phone`).
//
// Offline: no database, no network, no server. Run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOST_PHONE_STATUSES,
  HOST_PHONE_VISIBLE_SQL,
  hostPhoneVisible,
} from '../../src/lib/local/host-contact-core.ts'

describe('hostPhoneVisible', () => {
  test('a confirmed, paid booking shows the number', () => {
    assert.equal(hostPhoneVisible({ status: 'confirmed', payment_status: 'paid' }), true)
  })

  test('a completed, paid stay keeps showing it', () => {
    assert.equal(hostPhoneVisible({ status: 'completed', payment_status: 'paid' }), true)
  })

  test('host acceptance alone is not enough — payment must be approved', () => {
    for (const payment_status of ['unpaid', 'submitted', 'rejected', 'disputed', null, undefined]) {
      assert.equal(hostPhoneVisible({ status: 'confirmed', payment_status }), false, String(payment_status))
    }
  })

  test('a request still waiting on the host never shows it, paid or not', () => {
    assert.equal(hostPhoneVisible({ status: 'pending', payment_status: 'unpaid' }), false)
    assert.equal(hostPhoneVisible({ status: 'pending', payment_status: 'paid' }), false)
  })

  test('cancelled, rejected and refunded bookings hide it again', () => {
    assert.equal(hostPhoneVisible({ status: 'cancelled', payment_status: 'paid' }), false)
    assert.equal(hostPhoneVisible({ status: 'rejected', payment_status: 'paid' }), false)
    assert.equal(hostPhoneVisible({ status: 'confirmed', payment_status: 'refunded' }), false)
    assert.equal(hostPhoneVisible({ status: 'cancelled', payment_status: 'voided' }), false)
  })
})

describe('HOST_PHONE_VISIBLE_SQL', () => {
  test('names exactly the statuses the function allows, and requires paid', () => {
    for (const s of HOST_PHONE_STATUSES) assert.match(HOST_PHONE_VISIBLE_SQL, new RegExp(`'${s}'`))
    assert.doesNotMatch(HOST_PHONE_VISIBLE_SQL, /'pending'/)
    assert.match(HOST_PHONE_VISIBLE_SQL, /COALESCE\(b\.payment_status, 'unpaid'\) = 'paid'/)
  })
})
