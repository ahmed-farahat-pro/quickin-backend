// Unit tests for src/lib/local/account-status-core.ts — how this API reads the
// account lifecycle (D3 block / D4 remove) that /ops writes.
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and account-status-core.ts has no relative imports, which is
// what makes it loadable here. See README → Testing.
//
// The tests that matter most are under "the mobile contract": the iOS and Android
// apps branch on `403 && needsVerification` to reach their OTP screen, so a blocked
// login must be 403 WITHOUT that key or a suspended user gets routed to a
// verification screen they can pass and still be refused. That is not a detail these
// tests happen to cover — it is why this file exists.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCOUNT_STATUSES,
  ACTIVE_ACCOUNT_SQL,
  BLOCKED_STATUS_CODE,
  normalizeStatus,
  isActiveStatus,
  blockedLoginMessage,
  blockedLoginBody,
} from '../../src/lib/local/account-status-core.ts'

describe('normalizeStatus', () => {
  test('passes the three known statuses through', () => {
    for (const s of ACCOUNT_STATUSES) assert.equal(normalizeStatus(s), s)
  })

  test('is case- and whitespace-tolerant', () => {
    assert.equal(normalizeStatus(' BLOCKED '), 'blocked')
    assert.equal(normalizeStatus('Removed'), 'removed')
  })

  test('reads anything unknown as active, so a pre-migration row still signs in', () => {
    for (const v of [null, undefined, '', '   ', 'garbage', 7, {}]) {
      assert.equal(normalizeStatus(v), 'active')
    }
  })
})

describe('isActiveStatus', () => {
  test('only active passes', () => {
    assert.equal(isActiveStatus('active'), true)
    assert.equal(isActiveStatus('blocked'), false)
    assert.equal(isActiveStatus('removed'), false)
  })

  test('an absent column reads as active (fail open on unknown, not on known)', () => {
    assert.equal(isActiveStatus(null), true)
    assert.equal(isActiveStatus(undefined), true)
  })
})

describe('ACTIVE_ACCOUNT_SQL', () => {
  test('is COALESCE-guarded so it survives a pre-migration row', () => {
    assert.match(ACTIVE_ACCOUNT_SQL, /COALESCE\(account_status, 'active'\) = 'active'/)
  })

  test('carries no semicolon or comment marker — it is concatenated into WHERE clauses', () => {
    assert.doesNotMatch(ACTIVE_ACCOUNT_SQL, /[;]|--/)
  })
})

describe('blockedLoginMessage', () => {
  test('distinguishes suspended from closed', () => {
    assert.match(blockedLoginMessage('blocked'), /suspended/i)
    assert.match(blockedLoginMessage('removed'), /closed/i)
  })

  test('always points at support', () => {
    for (const s of ['blocked', 'removed']) {
      assert.match(blockedLoginMessage(s), /support@quickin\.app/)
    }
  })
})

describe('the mobile contract', () => {
  test('a blocked login is 403 — NOT a status the apps treat as anything special', () => {
    assert.equal(BLOCKED_STATUS_CODE, 403)
  })

  test('the body NEVER carries needsVerification', () => {
    for (const s of ['blocked', 'removed']) {
      const body = blockedLoginBody(s)
      assert.equal('needsVerification' in body, false)
      // Nor any casing variant that a client might sniff for.
      assert.equal(
        Object.keys(body).some((k) => k.toLowerCase().includes('verif')),
        false,
      )
    }
  })

  test('the body carries the message the apps display verbatim, plus the status', () => {
    const body = blockedLoginBody('blocked')
    assert.deepEqual(Object.keys(body).sort(), ['accountStatus', 'error'])
    assert.equal(body.accountStatus, 'blocked')
    assert.equal(body.error, blockedLoginMessage('blocked'))
  })

  test('an unknown status never produces a rejection body claiming to be one', () => {
    // Defensive: blockedLoginBody is only called after isActiveStatus fails, but if
    // it were ever called with junk it must not invent a status.
    assert.equal(blockedLoginBody('nonsense').accountStatus, 'active')
  })
})
