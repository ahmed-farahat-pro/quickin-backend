// Unit tests for src/lib/local/availability-core.ts — which bookings hold a
// listing's dates.
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and availability-core.ts has no relative imports, which is
// what makes it loadable here. See README → Testing.
//
// These tests pin the decision taken on 26 Aug 2026: a PENDING request holds
// nothing. It used to, which meant the first guest to ask took the nights off the
// market for everyone else — for a stay the host had not agreed to and might never
// agree to. Guest A asks, the host does nothing, Guest B is told the chalet is
// booked. The dates go off the market when the host ACCEPTS, not when someone asks.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DATE_HOLDING_STATUSES, holdsDates, holdsDatesSql, rangesOverlap, BookingConflictError,
} from '../../src/lib/local/availability-core.ts'

describe('holdsDates', () => {
  test('a pending request holds nothing — this is the whole bug', () => {
    // The reported failure, in one assertion. Everything else in this file exists
    // to stop it coming back through a different door.
    assert.equal(holdsDates('pending'), false)
  })

  test('an accepted stay holds its nights', () => {
    assert.equal(holdsDates('confirmed'), true)
    // A stay that already happened still owns the nights it happened on — otherwise
    // history would reopen for booking the moment a stay ended.
    assert.equal(holdsDates('completed'), true)
  })

  test('a booking that is over holds nothing', () => {
    assert.equal(holdsDates('rejected'), false)
    assert.equal(holdsDates('cancelled'), false)
  })

  test('every status in the vocabulary is answered, and only two say yes', () => {
    // The catalog lives in admin.ts / db.ts as BOOKING_STATUSES. If a sixth status
    // is ever added, this is the test that should make someone decide which side of
    // the line it falls on rather than defaulting into "holds nothing" by silence.
    const ALL = ['pending', 'confirmed', 'completed', 'rejected', 'cancelled']
    assert.deepEqual(ALL.filter(holdsDates), ['confirmed', 'completed'])
  })

  test('missing, blank and unrecognised statuses hold nothing', () => {
    // Fail OPEN, not closed: an unreadable status must not silently take a listing's
    // calendar off the market. A day wrongly on sale is caught at confirmation by
    // the clash check; a day wrongly withheld is invisible and just loses bookings.
    for (const bad of [undefined, null, '', '   ', 'nope', 42, {}]) {
      assert.equal(holdsDates(bad), false, `for ${JSON.stringify(bad)}`)
    }
  })

  test('case and surrounding space do not change the answer', () => {
    assert.equal(holdsDates(' CONFIRMED '), true)
    assert.equal(holdsDates('Pending'), false)
  })

  test('the catalog is the two, in order', () => {
    assert.deepEqual(DATE_HOLDING_STATUSES, ['confirmed', 'completed'])
  })
})

describe('holdsDatesSql', () => {
  // The SQL and the predicate are the same rule spelled twice — five queries in
  // db.ts read the SQL half, so a drift between the halves would put the guest
  // calendar and the clash check into disagreement.
  test('names exactly the statuses holdsDates accepts', () => {
    const sql = holdsDatesSql('b')
    for (const s of ['confirmed', 'completed']) assert.ok(sql.includes(`'${s}'`), s)
    for (const s of ['pending', 'rejected', 'cancelled']) assert.ok(!sql.includes(`'${s}'`), s)
  })

  test('qualifies the column with the alias it is given', () => {
    assert.equal(holdsDatesSql('b'), "b.status IN ('confirmed', 'completed')")
    assert.equal(holdsDatesSql('bk'), "bk.status IN ('confirmed', 'completed')")
  })

  test("an empty alias leaves the column bare, for an unaliased FROM bookings", () => {
    assert.equal(holdsDatesSql(''), "status IN ('confirmed', 'completed')")
    assert.ok(!holdsDatesSql('').startsWith('.'))
  })

  test('defaults to the b alias the booking queries use', () => {
    assert.equal(holdsDatesSql(), "b.status IN ('confirmed', 'completed')")
  })
})

describe('rangesOverlap', () => {
  test('a same-day turnover is not an overlap', () => {
    // Half-open [start, end): one guest checks out on the 10th, the next checks in
    // on the 10th. Closing the interval here would cost a night on every handover.
    assert.equal(rangesOverlap('2026-09-05', '2026-09-10', '2026-09-10', '2026-09-14'), false)
    assert.equal(rangesOverlap('2026-09-10', '2026-09-14', '2026-09-05', '2026-09-10'), false)
  })

  test('a single shared night is an overlap', () => {
    assert.equal(rangesOverlap('2026-09-05', '2026-09-11', '2026-09-10', '2026-09-14'), true)
  })

  test('containment counts, in both directions', () => {
    assert.equal(rangesOverlap('2026-09-01', '2026-09-30', '2026-09-10', '2026-09-12'), true)
    assert.equal(rangesOverlap('2026-09-10', '2026-09-12', '2026-09-01', '2026-09-30'), true)
  })

  test('identical ranges overlap — the rival-request case', () => {
    assert.equal(rangesOverlap('2026-09-10', '2026-09-14', '2026-09-10', '2026-09-14'), true)
  })

  test('ranges that do not touch do not overlap', () => {
    assert.equal(rangesOverlap('2026-09-01', '2026-09-05', '2026-09-20', '2026-09-25'), false)
  })

  test('crossing a month and a year boundary still compares correctly', () => {
    // ISO strings, compared as strings — which is only safe because the format is
    // zero-padded and fixed-width. These are the two places a looser format breaks.
    assert.equal(rangesOverlap('2026-08-28', '2026-09-02', '2026-09-01', '2026-09-03'), true)
    assert.equal(rangesOverlap('2026-12-30', '2027-01-02', '2027-01-01', '2027-01-05'), true)
    assert.equal(rangesOverlap('2026-12-30', '2027-01-01', '2027-01-01', '2027-01-05'), false)
  })
})

describe('BookingConflictError', () => {
  test('is an Error the route can single out for its 409', () => {
    const err = new BookingConflictError()
    assert.ok(err instanceof Error)
    assert.ok(err instanceof BookingConflictError)
    assert.equal(err.name, 'BookingConflictError')
    assert.ok(err.message.length > 0)
  })

  test('carries the message it is given', () => {
    assert.equal(new BookingConflictError('nope').message, 'nope')
  })
})
