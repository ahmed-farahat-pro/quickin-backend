// Unit tests for src/lib/local/inbox-core.ts — the seam that lets one Messages
// inbox serve two message stores.
//
// The bug this guards: `GET /api/local/chat` listed pre-booking conversations
// only, so a host who replied inside a reservation request sent a message that
// never appeared in the guest's inbox. The fix namespaces reservation threads as
// `booking:<uuid>` and merges them into the same list — so what has to hold is
// that the namespace round-trips, that a bare uuid still means what it always
// meant, and that the merged list is ordered by activity rather than by store.
//
// Offline: no database, no network. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. inbox-core.ts has no relative imports, which is what makes
// it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOKING_THREAD_PREFIX,
  INBOX_LIMIT,
  bookingThreadId,
  mergeInboxThreads,
  parseThreadId,
} from '../../src/lib/local/inbox-core.ts'

const CONVO = '11111111-2222-3333-4444-555555555555'
const BOOKING = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('thread ids', () => {
  test('a reservation id round-trips through the namespace', () => {
    const id = bookingThreadId(BOOKING)
    assert.equal(id, `${BOOKING_THREAD_PREFIX}${BOOKING}`)
    assert.deepEqual(parseThreadId(id), { kind: 'booking', id: BOOKING })
  })

  test('a bare uuid is still a pre-booking conversation', () => {
    assert.deepEqual(parseThreadId(CONVO), { kind: 'listing', id: CONVO })
  })

  test('the two namespaces cannot collide', () => {
    // A conversation id and a booking id can be the same uuid — they are keys in
    // different tables. The prefix is the only thing keeping the reads apart.
    assert.notEqual(bookingThreadId(CONVO), CONVO)
    assert.equal(parseThreadId(bookingThreadId(CONVO)).kind, 'booking')
    assert.equal(parseThreadId(CONVO).kind, 'listing')
  })

  test('anything that is not a well-formed id is rejected, not passed to a query', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      'not-a-uuid',
      `${BOOKING_THREAD_PREFIX}not-a-uuid`,
      BOOKING_THREAD_PREFIX,
      `${BOOKING_THREAD_PREFIX}${BOOKING}; DROP TABLE messages`,
      `${CONVO} OR 1=1`,
    ]) {
      assert.equal(parseThreadId(bad), null, `expected ${String(bad)} to be rejected`)
    }
  })

  test('a padded or differently-cased id still resolves', () => {
    assert.deepEqual(parseThreadId(`  ${BOOKING_THREAD_PREFIX}${BOOKING.toUpperCase()}  `), {
      kind: 'booking',
      id: BOOKING.toUpperCase(),
    })
  })
})

/** A row as either query returns it, with just the fields the merge reads. */
function row(id, lastMessageAt, extra = {}) {
  return { id, last_message_at: lastMessageAt, ...extra }
}

describe('mergeInboxThreads', () => {
  test('reservation threads appear in the inbox at all — the reported bug', () => {
    const merged = mergeInboxThreads([], [row(bookingThreadId(BOOKING), '2026-08-26T10:00:00Z')])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].kind, 'booking')
  })

  test('both stores interleave by activity, not by store', () => {
    const merged = mergeInboxThreads(
      [row('c1', '2026-08-20T09:00:00Z'), row('c2', '2026-08-26T12:00:00Z')],
      [row('b1', '2026-08-26T18:00:00Z'), row('b2', '2026-08-01T08:00:00Z')]
    )
    assert.deepEqual(merged.map((t) => t.id), ['b1', 'c2', 'c1', 'b2'])
  })

  test('a thread with no timestamp sorts last instead of to the top', () => {
    const merged = mergeInboxThreads([row('c1', null)], [row('b1', '2026-01-01T00:00:00Z')])
    assert.deepEqual(merged.map((t) => t.id), ['b1', 'c1'])
  })

  test('reservation context rides along, and only on reservation rows', () => {
    const [booking, listing] = mergeInboxThreads(
      [row('c1', '2026-08-01T00:00:00Z', { check_in: '2026-09-01', booking_status: 'confirmed' })],
      [
        row('b1', '2026-08-26T00:00:00Z', {
          booking_id: BOOKING,
          check_in: '2026-09-01',
          check_out: '2026-09-05',
          booking_status: 'confirmed',
        }),
      ]
    )
    assert.equal(booking.booking_id, BOOKING)
    assert.equal(booking.check_in, '2026-09-01')
    assert.equal(booking.check_out, '2026-09-05')
    assert.equal(booking.booking_status, 'confirmed')
    // A pre-booking thread is about a listing, not a stay — the columns exist on
    // the shared row shape but must never carry a value here.
    assert.equal(listing.kind, 'listing')
    assert.equal(listing.booking_id, null)
    assert.equal(listing.check_in, null)
    assert.equal(listing.booking_status, null)
  })

  test('the fields the clients already render survive the merge untouched', () => {
    const [t] = mergeInboxThreads(
      [
        row('c1', '2026-08-26T00:00:00Z', {
          listing_id: 'l1',
          listing_title: 'Sea view chalet',
          listing_image: 'https://blob/1.jpg',
          other_name: 'Nour',
          last_message: 'See you Friday',
          is_host: true,
        }),
      ],
      []
    )
    assert.equal(t.listing_id, 'l1')
    assert.equal(t.listing_title, 'Sea view chalet')
    assert.equal(t.listing_image, 'https://blob/1.jpg')
    assert.equal(t.other_name, 'Nour')
    assert.equal(t.last_message, 'See you Friday')
    assert.equal(t.is_host, true)
  })

  test('is_host is a real boolean even when the driver hands back something else', () => {
    const [t] = mergeInboxThreads([row('c1', '2026-08-26T00:00:00Z', { is_host: undefined })], [])
    assert.equal(t.is_host, false)
  })

  test('the same thread cannot be listed twice', () => {
    const merged = mergeInboxThreads(
      [row('c1', '2026-08-26T00:00:00Z'), row('c1', '2026-08-25T00:00:00Z')],
      []
    )
    assert.equal(merged.length, 1)
  })

  test('the union is capped, so two stores cannot double the payload', () => {
    const many = (prefix, n) =>
      Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, `2026-08-26T00:00:${String(i).padStart(2, '0')}Z`))
    const merged = mergeInboxThreads(many('c', INBOX_LIMIT), many('b', INBOX_LIMIT))
    assert.equal(merged.length, INBOX_LIMIT)
  })

  test('an empty or missing side is not an error', () => {
    assert.deepEqual(mergeInboxThreads([], []), [])
    assert.deepEqual(mergeInboxThreads(undefined, undefined), [])
  })
})
