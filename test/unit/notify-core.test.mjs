// Admin notifications — the pure rules behind POST /api/local/admin/notify and the
// /ops recipient picker. Offline: no database, no network. Run with `npm test`.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTIFY_MAX_USERS,
  NOTIFY_TITLE_MAX,
  NOTIFY_BODY_MAX,
  NotifyInputError,
  parseNotifyRequest,
  normalizeLink,
  normalizeUserIds,
  normalizeRecipientQuery,
  likeEscape,
} from '../../src/lib/local/notify-core.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('target', () => {
  test('no user_ids and no audience means everyone', () => {
    assert.deepEqual(parseNotifyRequest({ title: 'Hi' }).target, { kind: 'audience', audience: 'all' })
  })
  test('audience segments pass through', () => {
    for (const a of ['all', 'guests', 'hosts']) {
      assert.deepEqual(parseNotifyRequest({ title: 'Hi', audience: a }).target, { kind: 'audience', audience: a })
    }
  })
  test('an unknown audience is refused, not widened to everyone', () => {
    assert.throws(() => parseNotifyRequest({ title: 'Hi', audience: 'admins' }), NotifyInputError)
  })
  test('user_ids wins over audience — a named send never widens to a segment', () => {
    const r = parseNotifyRequest({ title: 'Hi', audience: 'all', user_ids: [A] })
    assert.deepEqual(r.target, { kind: 'users', userIds: [A] })
  })
  test('an empty user_ids list is refused rather than sent to nobody or everybody', () => {
    assert.throws(() => parseNotifyRequest({ title: 'Hi', user_ids: [] }), /at least one/)
  })
})

describe('user ids', () => {
  test('dedupes and lower-cases', () => {
    assert.deepEqual(normalizeUserIds([A, A.toUpperCase(), B]), [A, B])
  })
  test('refuses a non-uuid', () => {
    assert.throws(() => normalizeUserIds([A, "1' OR 1=1"]), /invalid id/)
  })
  test('refuses a non-list', () => {
    assert.throws(() => normalizeUserIds(A), /must be a list/)
  })
  test(`caps at ${NOTIFY_MAX_USERS}`, () => {
    const ids = Array.from({ length: NOTIFY_MAX_USERS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    assert.throws(() => normalizeUserIds(ids), /At most/)
    assert.equal(normalizeUserIds(ids.slice(0, NOTIFY_MAX_USERS)).length, NOTIFY_MAX_USERS)
  })
})

describe('content', () => {
  test('title is required and trimmed', () => {
    assert.throws(() => parseNotifyRequest({ title: '   ' }), /Title is required/)
    assert.equal(parseNotifyRequest({ title: '  Hi  ' }).title, 'Hi')
  })
  test('title and body have length caps', () => {
    assert.throws(() => parseNotifyRequest({ title: 'x'.repeat(NOTIFY_TITLE_MAX + 1) }), /Title/)
    assert.throws(() => parseNotifyRequest({ title: 'Hi', body: 'x'.repeat(NOTIFY_BODY_MAX + 1) }), /Message/)
  })
  test('an empty body becomes null', () => {
    assert.equal(parseNotifyRequest({ title: 'Hi', body: '  ' }).body, null)
  })
  test('push defaults on, email defaults off', () => {
    const r = parseNotifyRequest({ title: 'Hi' })
    assert.equal(r.push, true)
    assert.equal(r.email, false)
    assert.equal(parseNotifyRequest({ title: 'Hi', push: false, email: true }).push, false)
    assert.equal(parseNotifyRequest({ title: 'Hi', email: 'yes' }).email, false)
  })
  test('garbage body is a missing title, not a crash', () => {
    assert.throws(() => parseNotifyRequest(null), /Title is required/)
  })
})

describe('link', () => {
  test('app paths and https URLs are allowed', () => {
    assert.equal(normalizeLink('/reservations'), '/reservations')
    assert.equal(normalizeLink(' https://quickin.app/x '), 'https://quickin.app/x')
    assert.equal(normalizeLink(''), null)
  })
  test('anything a tap could abuse is refused', () => {
    for (const bad of ['javascript:alert(1)', 'http://x.com', '//evil.com', 'reservations', 'https://a b']) {
      assert.throws(() => normalizeLink(bad), NotifyInputError, bad)
    }
  })
})

describe('recipient search', () => {
  test('needs two characters', () => {
    assert.equal(normalizeRecipientQuery('a'), '')
    assert.equal(normalizeRecipientQuery(' ab '), 'ab')
    assert.equal(normalizeRecipientQuery(null), '')
  })
  test('LIKE wildcards match themselves', () => {
    assert.equal(likeEscape('50%_off\\'), '50\\%\\_off\\\\')
  })
})
