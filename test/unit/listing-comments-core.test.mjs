// Unit tests for src/lib/local/listing-comments-core.ts — the rules behind the
// public Q&A on a listing (which replaced host ⇄ guest messaging).
//
// Offline: no database, no network. Run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMENT_MAX,
  authorDisplayName,
  checkCommentBody,
  commentPermissions,
  commentsLink,
  sortForHost,
  toCommentDto,
} from '../../src/lib/local/listing-comments-core.ts'

const LISTING = '11111111-2222-3333-4444-555555555555'
const GUEST = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const HOST = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('checkCommentBody', () => {
  test('trims and accepts ordinary text', () => {
    assert.deepEqual(checkCommentBody('  Is the pool heated?  '), { ok: true, body: 'Is the pool heated?' })
  })
  test('refuses empty and whitespace-only text, worded per kind', () => {
    assert.deepEqual(checkCommentBody('   '), { ok: false, error: 'Comment cannot be empty' })
    assert.deepEqual(checkCommentBody(undefined, 'reply'), { ok: false, error: 'Reply cannot be empty' })
    assert.equal(checkCommentBody(42).ok, false)
  })
  test('the length cap applies after trimming', () => {
    assert.equal(checkCommentBody('x'.repeat(COMMENT_MAX)).ok, true)
    assert.equal(checkCommentBody(`  ${'x'.repeat(COMMENT_MAX)}  `).ok, true)
    assert.equal(checkCommentBody('x'.repeat(COMMENT_MAX + 1)).ok, false)
  })
})

describe('authorDisplayName', () => {
  test('first name and last initial', () => {
    assert.equal(authorDisplayName('Sara Ahmed'), 'Sara A.')
    assert.equal(authorDisplayName('  sara  mohamed ahmed '), 'sara A.')
  })
  test('a single name is shown as is', () => {
    assert.equal(authorDisplayName('Sara'), 'Sara')
  })
  test('no name falls back', () => {
    assert.equal(authorDisplayName(null), 'QuickIn guest')
    assert.equal(authorDisplayName('   '), 'QuickIn guest')
  })
})

describe('commentPermissions', () => {
  test('signed out: read only', () => {
    assert.deepEqual(commentPermissions(null, HOST), { is_host: false, can_comment: false })
  })
  test('a guest may comment', () => {
    assert.deepEqual(commentPermissions(GUEST, HOST), { is_host: false, can_comment: true })
  })
  test('the host replies instead of commenting', () => {
    assert.deepEqual(commentPermissions(HOST, HOST), { is_host: true, can_comment: false })
  })
})

describe('toCommentDto', () => {
  const row = {
    id: 'c1',
    listing_id: LISTING,
    user_id: GUEST,
    full_name: 'Sara Ahmed',
    avatar_url: '',
    body: 'Hi',
    created_at: new Date('2026-10-02T10:00:00Z'),
    host_reply: null,
    host_replied_at: null,
    listing_title: 'Villa',
    listing_image: null,
  }
  test('shapes the row and marks the viewer’s own comment', () => {
    const dto = toCommentDto(row, GUEST)
    assert.equal(dto.author_name, 'Sara A.')
    assert.equal(dto.author_avatar, null)
    assert.equal(dto.created_at, '2026-10-02T10:00:00.000Z')
    assert.equal(dto.mine, true)
    assert.equal(dto.reply, null)
    assert.equal('listing_title' in dto, false)
    assert.equal(toCommentDto(row, null).mine, false)
    assert.equal(toCommentDto(row, HOST).mine, false)
  })
  test('carries the host reply and, on request, the listing', () => {
    const dto = toCommentDto(
      { ...row, host_reply: 'Yes', host_replied_at: '2026-10-03T00:00:00.000Z' },
      null,
      true,
    )
    assert.deepEqual(dto.reply, { body: 'Yes', created_at: '2026-10-03T00:00:00.000Z' })
    assert.equal(dto.listing_title, 'Villa')
  })
})

test('sortForHost puts unanswered first, then newest', () => {
  const list = [
    { id: 'a', reply: { body: 'x' }, created_at: '2026-10-05' },
    { id: 'b', reply: null, created_at: '2026-10-01' },
    { id: 'c', reply: null, created_at: '2026-10-04' },
    { id: 'd', reply: { body: 'y' }, created_at: '2026-10-06' },
  ]
  assert.deepEqual(sortForHost(list).map((c) => c.id), ['c', 'b', 'd', 'a'])
})

test('commentsLink points at the listing’s comments anchor', () => {
  assert.equal(commentsLink(LISTING), `/explore/${LISTING}#comments`)
})
