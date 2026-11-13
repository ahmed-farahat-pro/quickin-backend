// Unit tests for src/lib/local/signup-identity-core.ts — when an account still
// owes its phone/ID, and when a booking is refused for it.
//
// Offline: no database, no network, no server. Run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIGNUP_IDENTITY_SOURCE,
  bookingIdentityBlock,
  identityState,
} from '../../src/lib/local/signup-identity-core.ts'

const required = (over = {}) =>
  identityState({ identityRequired: true, phone: '01012345678', verificationStatus: 'pending', ...over })

describe('identityState', () => {
  test('an account from before the cutover is always complete', () => {
    const s = identityState({ identityRequired: false, phone: null, verificationStatus: 'unverified' })
    assert.equal(s.identity_required, false)
    assert.equal(s.identity_complete, true)
  })

  test('a missing identity_required (pre-migration DB) reads as not required', () => {
    assert.equal(identityState({ identityRequired: undefined, phone: null, verificationStatus: null }).identity_complete, true)
  })

  test('only a literal true turns the requirement on', () => {
    assert.equal(identityState({ identityRequired: 'true', phone: null, verificationStatus: null }).identity_required, false)
  })

  test('a new Google account with nothing on file is incomplete', () => {
    assert.equal(required({ phone: null, verificationStatus: 'unverified' }).identity_complete, false)
  })

  test('a phone without a document is incomplete', () => {
    assert.equal(required({ verificationStatus: 'unverified' }).identity_complete, false)
  })

  test('a document without a phone is incomplete', () => {
    assert.equal(required({ phone: '  ' }).identity_complete, false)
  })

  test('phone + a pending, verified or rejected document is complete', () => {
    for (const verificationStatus of ['pending', 'verified', 'rejected']) {
      assert.equal(required({ verificationStatus }).identity_complete, true, verificationStatus)
    }
  })

  test('an unknown status reads as unverified', () => {
    assert.equal(required({ verificationStatus: 'weird' }).verification_status, 'unverified')
  })

  test('the note is only carried on a rejection', () => {
    assert.equal(required({ verificationStatus: 'rejected', verificationNote: ' Blurry ' }).verification_note, 'Blurry')
    assert.equal(required({ verificationStatus: 'pending', verificationNote: 'Blurry' }).verification_note, null)
    assert.equal(required({ verificationStatus: 'rejected', verificationNote: '' }).verification_note, null)
  })
})

describe('bookingIdentityBlock', () => {
  test('a pending document does not stop a booking', () => {
    assert.equal(bookingIdentityBlock(required()), null)
  })

  test('a verified document does not stop a booking', () => {
    assert.equal(bookingIdentityBlock(required({ verificationStatus: 'verified' })), null)
  })

  test('an incomplete account is refused', () => {
    assert.equal(bookingIdentityBlock(required({ phone: null }))?.code, 'identity_incomplete')
  })

  test('a rejected document is refused, with the reason in the message', () => {
    const b = bookingIdentityBlock(required({ verificationStatus: 'rejected', verificationNote: 'Blurry photo' }))
    assert.equal(b?.code, 'identity_rejected')
    assert.match(b.message, /Blurry photo/)
  })

  test('a rejection without a note still has a message', () => {
    assert.ok(bookingIdentityBlock(required({ verificationStatus: 'rejected' }))?.message)
  })

  test('accounts from before the cutover are never blocked, even when rejected', () => {
    const s = identityState({ identityRequired: false, phone: null, verificationStatus: 'rejected' })
    assert.equal(bookingIdentityBlock(s), null)
  })
})

test('the signup source matches the id_verifications vocabulary', () => {
  assert.equal(SIGNUP_IDENTITY_SOURCE, 'signup')
})
