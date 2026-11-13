// Unit tests for src/lib/local/host-application-core.ts — which source each
// field of a become-a-host application comes from (profile vs form), and the
// payout / host-terms requirements.
//
// Offline: no database, no network, no server. Run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILE_FIELDS,
  applicantProfile,
  resolveProfileField,
  hostTermsAccepted,
  payoutRequired,
  payoutSubmitted,
} from '../../src/lib/local/host-application-core.ts'

const full = {
  fullName: 'Mona Adel',
  phone: '01012345678',
  verificationStatus: 'verified',
  idNumber: '29801011234567',
}

describe('applicantProfile', () => {
  test('a signup-era account has everything on file', () => {
    const p = applicantProfile(full)
    assert.deepEqual(p.missing, [])
    assert.equal(p.onFile.national_id, '29801011234567')
  })

  test('a pending ID still supplies its number', () => {
    const p = applicantProfile({ ...full, verificationStatus: 'pending' })
    assert.equal(p.onFile.national_id, '29801011234567')
  })

  test('a rejected or absent ID supplies no number', () => {
    for (const s of ['rejected', 'unverified', '', null]) {
      const p = applicantProfile({ ...full, verificationStatus: s })
      assert.equal(p.onFile.national_id, null, String(s))
      assert.deepEqual(p.missing, ['national_id'])
    }
  })

  test('a legacy account without a phone is asked for it', () => {
    const p = applicantProfile({ ...full, phone: null })
    assert.deepEqual(p.missing, ['phone'])
  })

  test('blank strings count as missing, in form order', () => {
    const p = applicantProfile({ fullName: '  ', phone: '', verificationStatus: 'verified', idNumber: ' ' })
    assert.deepEqual(p.missing, [...PROFILE_FIELDS])
  })
})

describe('resolveProfileField', () => {
  test('the profile wins over a submitted value', () => {
    const p = applicantProfile(full)
    assert.equal(resolveProfileField(p, 'phone', '01199999999'), '01012345678')
    assert.equal(resolveProfileField(p, 'full_name', 'Someone Else'), 'Mona Adel')
  })

  test('a submitted value fills a gap, trimmed', () => {
    const p = applicantProfile({ ...full, phone: null })
    assert.equal(resolveProfileField(p, 'phone', ' 01199999999 '), '01199999999')
  })

  test('no profile value and nothing submitted is empty', () => {
    const p = applicantProfile({ ...full, phone: null })
    assert.equal(resolveProfileField(p, 'phone', undefined), '')
  })
})

describe('hostTermsAccepted', () => {
  test('only an explicit yes counts', () => {
    assert.equal(hostTermsAccepted(true), true)
    assert.equal(hostTermsAccepted('true'), true)
    for (const v of [false, 'false', undefined, null, 1, 'yes', '']) {
      assert.equal(hostTermsAccepted(v), false, String(v))
    }
  })
})

describe('payout', () => {
  test('required only when none is on file', () => {
    assert.equal(payoutRequired(false), true)
    assert.equal(payoutRequired(true), false)
  })

  test('payoutSubmitted wants a non-empty object', () => {
    assert.equal(payoutSubmitted({ method: 'instapay' }), true)
    for (const v of [undefined, null, {}, [], 'instapay', 0]) {
      assert.equal(payoutSubmitted(v), false, JSON.stringify(v))
    }
  })
})
