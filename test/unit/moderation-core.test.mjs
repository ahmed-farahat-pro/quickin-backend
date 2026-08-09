// Unit tests for src/lib/local/moderation-core.ts — the decisions behind /ops →
// Moderation and the warning acknowledge gate.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. moderation-core.ts has no relative imports, which is what
// makes it loadable here at all. See README → Testing.
//
// The things worth locking down here are the ones a future edit could quietly
// break: the flag threshold (one attempt, not three), the wire contract the three
// clients branch on, and the normalizers that keep a row written by a newer
// deploy from throwing on an older one.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  VIOLATION_KINDS,
  VIOLATION_SURFACES,
  normalizeKind,
  normalizeSurface,
  kindLabel,
  surfaceLabel,
  FLAG_THRESHOLD,
  isFlagged,
  MAX_BODY_CHARS,
  truncateBody,
  MODERATION_ACTIONS,
  isModerationAction,
  auditActionFor,
  MAX_WARNING_CHARS,
  DEFAULT_WARNING,
  normalizeWarning,
  warningGateBody,
  WARNING_GATE_STATUS,
  attemptsLabel,
  violationSummary,
} from '../../src/lib/local/moderation-core.ts'

describe('kinds and surfaces', () => {
  test('the catalog matches contentguard’s four categories', () => {
    assert.deepEqual([...VIOLATION_KINDS], ['phone', 'email', 'social', 'url'])
    assert.deepEqual([...VIOLATION_SURFACES], ['chat', 'review', 'listing', 'profile'])
  })

  test('a row written by a newer deploy falls back instead of throwing', () => {
    // The moderation screen must not 500 because a future version recorded a
    // category this build has never heard of.
    assert.equal(normalizeKind('something-new'), 'phone')
    assert.equal(normalizeSurface('something-new'), 'chat')
    assert.equal(normalizeKind(null), 'phone')
    assert.equal(normalizeSurface(undefined), 'chat')
  })

  test('known values survive normalization', () => {
    for (const k of VIOLATION_KINDS) assert.equal(normalizeKind(k), k)
    for (const s of VIOLATION_SURFACES) assert.equal(normalizeSurface(s), s)
  })

  test('every kind and surface has a human label', () => {
    for (const k of VIOLATION_KINDS) assert.match(kindLabel(k), /\w/)
    for (const s of VIOLATION_SURFACES) assert.match(surfaceLabel(s), /\w/)
    assert.equal(kindLabel('phone'), 'Phone number')
    assert.equal(surfaceLabel('listing'), 'Listing')
  })
})

describe('what counts as flagged', () => {
  test('one attempt is enough', () => {
    // Deliberate: the guard already refused the message, so a row is a recorded
    // attempt, not a suspicion. A threshold would hide the first two attempts by
    // everyone — exactly the population worth seeing.
    assert.equal(FLAG_THRESHOLD, 1)
    assert.equal(isFlagged(1), true)
  })

  test('zero attempts is not flagged', () => {
    assert.equal(isFlagged(0), false)
    assert.equal(isFlagged(null), false)
    assert.equal(isFlagged(undefined), false)
  })

  test('more attempts stay flagged', () => {
    assert.equal(isFlagged(2), true)
    assert.equal(isFlagged(40), true)
  })
})

describe('stored body', () => {
  test('short text is stored verbatim', () => {
    assert.equal(truncateBody('call me 01012345678'), 'call me 01012345678')
  })

  test('a pasted novel is bounded', () => {
    const long = 'x'.repeat(MAX_BODY_CHARS + 500)
    const out = truncateBody(long)
    assert.equal(out.length, MAX_BODY_CHARS)
    assert.ok(out.endsWith('…'))
  })

  test('null and undefined become empty, not the string "null"', () => {
    assert.equal(truncateBody(null), '')
    assert.equal(truncateBody(undefined), '')
  })
})

describe('moderator actions', () => {
  test('the three actions are warn, suspend, dismiss', () => {
    assert.deepEqual([...MODERATION_ACTIONS], ['warn', 'suspend', 'dismiss'])
  })

  test('permanent removal is NOT a moderation action', () => {
    // It stays behind the `users` module on purpose, so someone granted only
    // `moderation` can stop an account without being able to erase it.
    assert.equal(isModerationAction('remove'), false)
    assert.equal(isModerationAction('delete'), false)
  })

  test('junk is rejected', () => {
    for (const v of ['', null, undefined, 'WARN', 'drop table']) {
      assert.equal(isModerationAction(v), false, `should reject ${JSON.stringify(v)}`)
    }
  })

  test('each action has a distinct, prefixed audit name', () => {
    const names = MODERATION_ACTIONS.map(auditActionFor)
    assert.deepEqual(names, ['moderation_warn', 'moderation_suspend', 'moderation_dismiss'])
    assert.equal(new Set(names).size, names.length)
  })
})

describe('the warning text', () => {
  test('an empty custom message falls back to the default', () => {
    // Under this design nothing else notifies the user, so a blank warning would
    // be a blocking dialog with no explanation in it.
    assert.equal(normalizeWarning(''), DEFAULT_WARNING)
    assert.equal(normalizeWarning('   '), DEFAULT_WARNING)
    assert.equal(normalizeWarning(null), DEFAULT_WARNING)
    assert.equal(normalizeWarning(undefined), DEFAULT_WARNING)
  })

  test('a custom message is kept and trimmed', () => {
    assert.equal(normalizeWarning('  Please stop.  '), 'Please stop.')
  })

  test('an over-long message is bounded', () => {
    const out = normalizeWarning('y'.repeat(MAX_WARNING_CHARS + 200))
    assert.equal(out.length, MAX_WARNING_CHARS)
    assert.ok(out.endsWith('…'))
  })

  test('the default explains the rule and the consequence', () => {
    assert.match(DEFAULT_WARNING, /contact details/i)
    assert.match(DEFAULT_WARNING, /suspend/i)
  })
})

describe('the gate contract the clients branch on', () => {
  test('409, not 403', () => {
    // 403 already means "blocked account" on these routes and the apps route that
    // to a different screen entirely.
    assert.equal(WARNING_GATE_STATUS, 409)
  })

  test('the body carries the warning in BOTH fields', () => {
    const body = warningGateBody({ id: 'abc', message: 'Please keep it on QuickIn.' })
    assert.deepEqual(body, {
      error: 'Please keep it on QuickIn.',
      policyWarning: { id: 'abc', message: 'Please keep it on QuickIn.' },
    })
  })

  test('`error` repeats the warning so an old client still shows it', () => {
    // A build that predates the acknowledge dialog only knows how to display
    // `error`. If that were a generic refusal the user would see a dead end.
    const body = warningGateBody({ id: 'x', message: 'Specific warning text' })
    assert.equal(body.error, body.policyWarning.message)
  })
})

describe('display helpers', () => {
  test('attempts are pluralised', () => {
    assert.equal(attemptsLabel(1), '1 attempt')
    assert.equal(attemptsLabel(2), '2 attempts')
    assert.equal(attemptsLabel(0), '0 attempts')
  })

  test('a summary leads with the dominant behaviour', () => {
    assert.equal(violationSummary({ phone: 2, url: 5 }), '5 external link, 2 phone number')
  })

  test('zero counts are dropped', () => {
    assert.equal(violationSummary({ phone: 3, email: 0, social: 0, url: 0 }), '3 phone number')
  })

  test('nothing recorded reads as a dash, not an empty string', () => {
    assert.equal(violationSummary({}), '—')
    assert.equal(violationSummary({ phone: 0 }), '—')
  })

  test('ties fall back to catalog order, so the label is stable', () => {
    assert.equal(violationSummary({ url: 1, phone: 1 }), '1 phone number, 1 external link')
  })
})
