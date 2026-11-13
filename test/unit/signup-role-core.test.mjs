// Unit tests for src/lib/local/signup-role-core.ts — the Guest/Host choice at
// signup, the steps each role walks, and the host-only hosting page.
//
// Offline: no database, no network, no server. Run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SIGNUP_HOST_TYPES,
  SIGNUP_STEPS,
  hasMoneyDestination,
  normalizeSignupRole,
  readHostingDetails,
} from '../../src/lib/local/signup-role-core.ts'

describe('normalizeSignupRole', () => {
  test('host is host, in any case and padding', () => {
    assert.equal(normalizeSignupRole('host'), 'host')
    assert.equal(normalizeSignupRole('  HOST '), 'host')
  })

  test('a missing role is a guest — every build from before the change', () => {
    assert.equal(normalizeSignupRole(undefined), 'guest')
    assert.equal(normalizeSignupRole(null), 'guest')
  })

  test('anything unknown is a guest, never an elevated role', () => {
    assert.equal(normalizeSignupRole('admin'), 'guest')
    assert.equal(normalizeSignupRole(1), 'guest')
  })
})

describe('SIGNUP_STEPS', () => {
  test('a host walks every guest page but the refund one, plus hosting and payout', () => {
    assert.deepEqual([...SIGNUP_STEPS.guest], ['account', 'identity', 'refund'])
    assert.deepEqual([...SIGNUP_STEPS.host], ['account', 'identity', 'hosting', 'payout'])
    assert.equal(SIGNUP_STEPS.host.length, SIGNUP_STEPS.guest.length + 1)
  })
})

describe('hasMoneyDestination', () => {
  test('a skipped step reads as nothing given', () => {
    for (const v of [undefined, null, {}, { method: '' }, { method: '  ' }, [], 'bank_account']) {
      assert.equal(hasMoneyDestination(v), false, JSON.stringify(v))
    }
  })

  test('any chosen method counts — the validator judges the rest', () => {
    assert.equal(hasMoneyDestination({ method: 'instapay' }), true)
  })
})

describe('readHostingDetails', () => {
  test('a complete individual drops the company', () => {
    const r = readHostingDetails({ host_type: 'Individual', address: ' 12  Nile St ', company: 'Acme' })
    assert.deepEqual(r.hosting, { host_type: 'individual', address: '12 Nile St', company: null, notes: null })
  })

  test('company stays optional, as on /host/apply', () => {
    const r = readHostingDetails({ host_type: 'company', address: 'Cairo' })
    assert.equal(r.fields, undefined)
    assert.equal(r.hosting.company, null)
  })

  test('company and notes kept for a brokerage; notes keep line breaks', () => {
    const r = readHostingDetails({ hostType: 'brokerage', address: 'Giza', company: 'Nile Homes', notes: 'a\nb ' })
    assert.equal(r.hosting.company, 'Nile Homes')
    assert.equal(r.hosting.notes, 'a\nb')
  })

  test('missing type and address are reported per field', () => {
    const r = readHostingDetails({})
    assert.ok(r.fields.host_type)
    assert.ok(r.fields.address)
    assert.equal(r.hosting, undefined)
  })

  test('an unknown host type is refused', () => {
    assert.ok(readHostingDetails({ host_type: 'landlord', address: 'x' }).fields.host_type)
  })

  test('over-long fields are refused rather than truncated', () => {
    const r = readHostingDetails({ host_type: 'company', address: 'a'.repeat(301), company: 'c'.repeat(121), notes: 'n'.repeat(1001) })
    assert.ok(r.fields.address)
    assert.ok(r.fields.company)
    assert.ok(r.fields.notes)
  })
})

test('SIGNUP_HOST_TYPES matches HOST_TYPES in db.ts', () => {
  const db = readFileSync(new URL('../../src/lib/local/db.ts', import.meta.url), 'utf8')
  const m = db.match(/export const HOST_TYPES = \[([^\]]*)\]/)
  assert.ok(m, 'HOST_TYPES not found in db.ts')
  const fromDb = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  assert.deepEqual(fromDb, [...SIGNUP_HOST_TYPES])
})
