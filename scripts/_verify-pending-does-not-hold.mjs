// Proves the reported bug is gone: a PENDING request must not take dates off the
// market, and accepting one must settle the contest cleanly.
//
//   DATABASE_URL='postgresql://localhost:5432/quickin_local' \
//     node --import ./scripts/_ts-resolve-hook.mjs scripts/_verify-pending-does-not-hold.mjs
//
// The rule itself is unit-tested (test/unit/availability-core.test.mjs), but the
// rule is only half of it: five queries in db.ts have to actually read it, and the
// confirm path has to hold a lock and sweep the losers. That needs a database, so
// this is a script rather than a unit test. It creates its own listing, host and
// guests and deletes them again — it does NOT touch existing rows.
import pg from 'pg'
import {
  createBooking, setBookingStatus, getListingAvailability, getListings,
} from '../src/lib/local/db.ts'
import { BookingConflictError } from '../src/lib/local/availability-core.ts'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
const day = (n) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const IN = day(40), OUT = day(43)

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ---- fixtures ---------------------------------------------------------------
const mk = async (email) => (await pool.query(
  `INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id::text AS id`,
  [email, email.split('@')[0]],
)).rows[0].id
const stamp = process.pid
const hostId = await mk(`verify-host-${stamp}@example.test`)
const guestA = await mk(`verify-a-${stamp}@example.test`)
const guestB = await mk(`verify-b-${stamp}@example.test`)
const guestC = await mk(`verify-c-${stamp}@example.test`)
const listingId = (await pool.query(
  `INSERT INTO listings (host_id, title, price_per_night, max_guests, is_published, approval_status)
   VALUES ($1, 'Verify pending-hold ${stamp}', 1000, 8, true, 'approved') RETURNING id::text AS id`,
  [hostId],
)).rows[0].id

const cleanup = async () => {
  await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [[hostId, guestA, guestB, guestC]])
  await pool.query(`DELETE FROM bookings WHERE listing_id = $1`, [listingId])
  await pool.query(`DELETE FROM listing_blocked_dates WHERE listing_id = $1`, [listingId])
  await pool.query(`DELETE FROM listings WHERE id = $1`, [listingId])
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[hostId, guestA, guestB, guestC]])
}

try {
  console.log(`\nlisting ${listingId}, nights ${IN} → ${OUT}\n`)

  // ---- 1. rival requests ----------------------------------------------------
  console.log('rival requests for the same nights')
  const a = await createBooking({ listingId, userId: guestA, checkIn: IN, checkOut: OUT, guests: 2 })
  check('guest A can request', a.status === 'pending', `status=${a.status}`)

  let b = null
  try {
    b = await createBooking({ listingId, userId: guestB, checkIn: IN, checkOut: OUT, guests: 2 })
  } catch (err) {
    check('guest B can request the SAME nights while A is pending', false, err.message)
  }
  if (b) check('guest B can request the SAME nights while A is pending', b.status === 'pending')

  const c = await createBooking({ listingId, userId: guestC, checkIn: IN, checkOut: day(42), guests: 2 })
  check('guest C can request an OVERLAPPING window', c.status === 'pending')

  let dupe = null
  try {
    dupe = await createBooking({ listingId, userId: guestA, checkIn: IN, checkOut: OUT, guests: 2 })
  } catch (err) {
    check('the same guest cannot double-tap the same nights', /already have a request/i.test(err.message), err.message)
  }
  if (dupe) check('the same guest cannot double-tap the same nights', false, 'a second row was created')

  // ---- 2. what the guest and search see -------------------------------------
  console.log('\nwhat the calendar and search show while everything is pending')
  const spansPending = await getListingAvailability(listingId)
  check('the public calendar greys out nothing', spansPending.length === 0, JSON.stringify(spansPending))
  const found = await getListings({ checkIn: IN, checkOut: OUT })
  check('dated search still returns the listing', found.some((l) => l.id === listingId))

  // ---- 3. the host accepts one ----------------------------------------------
  console.log('\nthe host accepts guest A')
  const accepted = await setBookingStatus(a.id, hostId, 'confirmed')
  check('A is confirmed and gets a reservation code', accepted?.status === 'confirmed' && !!accepted?.reservation_code)

  const after = await pool.query(
    `SELECT id::text AS id, status FROM bookings WHERE listing_id = $1`, [listingId],
  )
  const statusOf = (id) => after.rows.find((r) => r.id === id)?.status
  check('B — the displaced rival — is declined', statusOf(b?.id) === 'rejected', statusOf(b?.id))
  check('C — the overlapping rival — is declined', statusOf(c.id) === 'rejected', statusOf(c.id))

  const spansAfter = await getListingAvailability(listingId)
  check('the calendar now greys out exactly one span', spansAfter.length === 1, JSON.stringify(spansAfter))
  check('and it is the accepted stay', spansAfter[0]?.start === IN && spansAfter[0]?.end === OUT && spansAfter[0]?.kind === 'booked')
  const foundAfter = await getListings({ checkIn: IN, checkOut: OUT })
  check('dated search no longer returns the listing', !foundAfter.some((l) => l.id === listingId))

  // ---- 4. the dates are genuinely gone now ----------------------------------
  console.log('\nafter acceptance the nights are really taken')
  let late = null
  try {
    late = await createBooking({ listingId, userId: guestB, checkIn: IN, checkOut: OUT, guests: 2 })
  } catch (err) {
    check('a new request for those nights is refused', /not available/i.test(err.message), err.message)
  }
  if (late) check('a new request for those nights is refused', false, 'it was accepted')

  const turnover = await createBooking({ listingId, userId: guestB, checkIn: OUT, checkOut: day(46), guests: 2 })
  check('a same-day turnover is still allowed', turnover.status === 'pending')

  // ---- 5. the host cannot double-book ---------------------------------------
  console.log('\nthe host cannot give the same nights away twice')
  const rival = await createBooking({ listingId, userId: guestC, checkIn: day(60), checkOut: day(63), guests: 2 })
  const rival2 = await createBooking({ listingId, userId: guestB, checkIn: day(60), checkOut: day(63), guests: 2 })
  await setBookingStatus(rival.id, hostId, 'confirmed')
  // rival2 was swept to 'rejected' by that acceptance; force it back to pending to
  // simulate a host clicking Approve on a stale inbox row.
  await pool.query(`UPDATE bookings SET status = 'pending' WHERE id = $1`, [rival2.id])
  let conflict = null
  try {
    await setBookingStatus(rival2.id, hostId, 'confirmed')
  } catch (err) {
    conflict = err
  }
  check('confirming over a confirmed stay throws BookingConflictError',
    conflict instanceof BookingConflictError, conflict ? conflict.message : 'nothing was thrown')
  const stale = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [rival2.id])
  check('and the stale request is left untouched', stale.rows[0].status === 'pending', stale.rows[0].status)

  // ---- 6. a host block also blocks acceptance -------------------------------
  console.log('\na block on the host calendar blocks acceptance too')
  const blocked = await createBooking({ listingId, userId: guestA, checkIn: day(80), checkOut: day(83), guests: 2 })
  await pool.query(
    `INSERT INTO listing_blocked_dates (listing_id, start_date, end_date) VALUES ($1, $2, $3)`,
    [listingId, day(81), day(82)],
  )
  let blockErr = null
  try { await setBookingStatus(blocked.id, hostId, 'confirmed') } catch (err) { blockErr = err }
  check('confirming over a self-blocked range throws BookingConflictError',
    blockErr instanceof BookingConflictError, blockErr ? blockErr.message : 'nothing was thrown')
} finally {
  await cleanup()
  await pool.end()
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
