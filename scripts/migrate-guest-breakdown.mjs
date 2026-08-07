// bookings.adults / children / infants / pets — the guest breakdown.
//
// These columns have been read by BOOKING_COLS in BOTH repos for a long time, but no
// migration script ever created them: they exist on Neon (added by hand, or by one of
// the deleted xmig routes) and nowhere else. The result is that a database built by
// setup-local.mjs cannot run a single booking query — GET /api/local/bookings, the
// reservations page and the payment flow all 500 with `column b.adults does not exist`.
// This is the same gap migrate-web-tables.mjs was written to close for the web tables.
//
// Backfilled from `guests`, which is the pre-breakdown headcount, so existing rows
// read as "all adults" rather than zero.
//   node quickin-backend/scripts/migrate-guest-breakdown.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const _cs = dbUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })

const DDL = `
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS adults   int NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS children int NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS infants  int NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pets     int NOT NULL DEFAULT 0;
`

;(async () => {
  await pool.query(DDL)
  // Adults defaults to 1, which would under-count a party of four booked before the
  // breakdown existed. `guests` is the number they actually booked for.
  const back = await pool.query(
    `UPDATE bookings SET adults = GREATEST(1, COALESCE(guests, 1))
      WHERE adults = 1 AND COALESCE(guests, 1) > 1`
  )

  const want = ['adults', 'children', 'infants', 'pets']
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'bookings' AND column_name = ANY($1)`,
    [want]
  )
  const found = rows.map((r) => r.column_name)
  for (const c of want) console.log(`bookings.${c}:`, found.includes(c) ? '✅' : '❌')
  console.log('rows backfilled from guests:', back.rowCount)
  await pool.end()
  if (found.length < want.length) process.exit(1)
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
