// Regression guard for the host reservations inbox — GET /api/local/host/bookings.
//
// Offline: no database, no network. Run with `npm test`.
//
// Why a source assertion rather than a normal unit test: what broke here was a
// SQL projection, and `db.ts` cannot be imported by a test (its extension-less
// relative imports — see README → Testing). There is no pure-logic seam to test
// instead, because the defect WAS the SELECT list.
//
// The history it guards: this repo and the web app each used to own a copy of
// this route. When they were merged, the surviving query kept the shared booking
// projection but lost the two host-only columns the web copy added — so a host's
// inbox stopped saying who was asking, and every request read "A guest". The
// same merge is on record for dropping `?asHost` and `weekend_days` the same
// silent way. Nothing caught any of them, which is what this file is for.
//
// Deliberately loose: it asserts the columns are selected, not how the query is
// written. Reformat, reorder or re-alias freely; only removing a column fails.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('../../src/lib/local/db.ts', import.meta.url)),
  'utf8'
)

/** The body of `getHostBookings`, from its signature to the closing brace. */
function getHostBookingsSource() {
  const start = SRC.indexOf('export async function getHostBookings')
  assert.notEqual(start, -1, 'getHostBookings has been renamed or removed')
  const end = SRC.indexOf('\n}', start)
  assert.notEqual(end, -1, 'could not find the end of getHostBookings')
  return SRC.slice(start, end)
}

describe('getHostBookings projection', () => {
  const sql = getHostBookingsSource()

  test('selects guest_name — the host has to know who is asking before they decide', () => {
    assert.match(
      sql,
      /AS guest_name/,
      'the host inbox reads b.guest_name; without it every request renders as "A guest"'
    )
  })

  test('joins the guest LEFT, so a deleted account does not delete the host record', () => {
    assert.match(
      sql,
      /LEFT JOIN\s+users/i,
      'an inner join here would drop reservations whose guest account is gone'
    )
  })

  test('selects host_payout — the raw amount owed, which the shared projection withholds', () => {
    assert.match(sql, /AS host_payout/)
  })

  test('is scoped to the signed-in host, never to a listing id from the caller', () => {
    assert.match(sql, /l\.host_id = \$1/)
  })

  test('is newest-first, which is the order the inbox renders and does not re-sort', () => {
    assert.match(sql, /ORDER BY b\.created_at DESC/)
  })
})
