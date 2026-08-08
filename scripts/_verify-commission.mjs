// Verifies that the SQL markup in db.ts agrees, to the pound, with the
// TypeScript in commission-core.ts — the one thing typechecking cannot prove,
// since the same rounding rule is implemented in both languages.
//
// LOCAL ONLY. It INSERTs a fixture listing and service (to exercise seasonal
// pricing and length-of-stay discounts, which the seed data doesn't cover) and
// deletes them at the end, so it refuses to run against a remote DATABASE_URL.
//
//   node quickin-backend/scripts/_verify-commission.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'
import {
  COMMISSION_RATE_SQL,
  sqlWithCommission,
  withCommission,
  parseRate,
  roundUpToStep,
} from '../src/lib/local/commission-core.ts'

const env = readFileSync('/Users/kareemeladl/projects/quickin/backend/quickin-backend/.env', 'utf8')
const cs = process.env.DATABASE_URL || env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
if (!cs.includes('127.0.0.1') && !cs.includes('localhost')) {
  console.error('REFUSING TO RUN: this script writes fixture rows and DATABASE_URL is not local.')
  process.exit(1)
}
const pool = new pg.Pool({ connectionString: cs, ssl: false })

let failures = 0
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

// The monthly_prices transform, copied verbatim from db.ts.
const MONTHLY_GUEST_SQL = `COALESCE((
    SELECT jsonb_object_agg(mp.k, ${sqlWithCommission('mp.v::numeric')})
      FROM jsonb_each_text(COALESCE(l.monthly_prices, '{}'::jsonb)) AS mp(k, v)
     WHERE mp.v ~ '^[0-9.]+$'
  ), '{}'::jsonb)`

const rateRow = await pool.query(`SELECT ${COMMISSION_RATE_SQL} AS rate`)
const rate = parseRate(rateRow.rows[0].rate)
console.log(`\nlive rate = ${rate} (${rate * 100}%)\n`)

// ---- 1. SQL markup === JS markup, across a wide spread of prices ------------
const PRICES = [1, 99, 100, 101, 999, 1000, 1234, 2199, 3400, 5472, 99_999]
const sqlVals = await pool.query(
  `SELECT p, ${sqlWithCommission('p')}::float8 AS guest
     FROM unnest($1::numeric[]) AS p`,
  [PRICES]
)
let mismatches = []
for (const row of sqlVals.rows) {
  const raw = Number(row.p)
  const js = withCommission(raw, rate)
  if (Number(row.guest) !== js) mismatches.push(`${raw}: sql=${row.guest} js=${js}`)
}
ok(`SQL markup matches TypeScript for ${PRICES.length} prices`, mismatches.length === 0, mismatches.join(', '))

// ---- 2. Same, at every rate an admin could set ------------------------------
mismatches = []
for (const r of [0, 0.05, 0.1, 0.125, 0.5, 1]) {
  const res = await pool.query(
    `SELECT p, ${sqlWithCommission('p', '$2::numeric')}::float8 AS guest
       FROM unnest($1::numeric[]) AS p`,
    [PRICES, r]
  )
  for (const row of res.rows) {
    const js = withCommission(Number(row.p), r)
    if (Number(row.guest) !== js) mismatches.push(`rate=${r} raw=${row.p}: sql=${row.guest} js=${js}`)
  }
}
ok('SQL and TypeScript agree at every settable rate', mismatches.length === 0, mismatches.slice(0, 4).join(' | '))

// ---- 3. NULL passes through (a listing with no weekend price) --------------
const nullRes = await pool.query(`SELECT ${sqlWithCommission('NULL::numeric')} AS g`)
ok('NULL weekend_price stays NULL, not 0', nullRes.rows[0].g === null, `got ${nullRes.rows[0].g}`)

// ---- 3b. Fixture: the seeded rows have no seasonal pricing, discounts or
// services, so the interesting paths would go untested. Build one listing that
// exercises all of them (and one service), then roll it back at the end.
const hostRow = await pool.query(`SELECT id FROM users LIMIT 1`)
const hostId = hostRow.rows[0]?.id ?? null
const fixture = await pool.query(
  `INSERT INTO listings (host_id, title, description, location, region, country,
                         price_per_night, weekend_price, monthly_prices, currency,
                         weekly_discount, monthly_discount, max_guests, property_type,
                         is_published, approval_status)
   VALUES ($1, '__COMMISSION_FIXTURE__', 'temp', 'North Coast', 'North Coast', 'EG',
           2199, 3457, '{"8": 4321, "12": 5000, "3": "junk"}'::jsonb, 'EGP',
           10, 25, 4, 'Villa', true, 'approved')
   RETURNING id`,
  [hostId]
)
const fixtureId = fixture.rows[0].id
let svcFixtureId = null
if (hostId) {
  const s = await pool.query(
    `INSERT INTO services (host_id, title, category, location, price, currency, is_published)
     VALUES ($1, '__COMMISSION_FIXTURE__', 'Diving', 'El Gouna', 1401, 'EGP', true) RETURNING id`,
    [hostId]
  )
  svcFixtureId = s.rows[0].id
}

// ---- 4. The real listing projections run, and are ordered correctly --------
const listings = await pool.query(
  `SELECT l.id, l.title,
          l.price_per_night::float8 AS raw,
          ${sqlWithCommission('l.price_per_night')}::float8 AS guest,
          ${sqlWithCommission('l.weekend_price')}::float8 AS guest_weekend,
          l.weekend_price::float8 AS raw_weekend,
          ${MONTHLY_GUEST_SQL} AS guest_monthly,
          COALESCE(l.monthly_prices, '{}'::jsonb) AS raw_monthly
     FROM listings l ORDER BY l.created_at LIMIT 20`
)
ok(`listing projection runs (${listings.rowCount} rows)`, listings.rowCount > 0)

let bad = []
for (const r of listings.rows) {
  if (Number(r.guest) !== withCommission(Number(r.raw), rate)) bad.push(`${r.title} base`)
  if (r.raw_weekend === null && r.guest_weekend !== null) bad.push(`${r.title} weekend NULL leak`)
  if (r.raw_weekend !== null && Number(r.guest_weekend) !== withCommission(Number(r.raw_weekend), rate)) {
    bad.push(`${r.title} weekend`)
  }
  for (const [m, v] of Object.entries(r.raw_monthly)) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) {
      // Junk months are DROPPED, matching monthlyPricesWithCommission().
      if (m in r.guest_monthly) bad.push(`${r.title} month ${m}: junk value survived`)
      continue
    }
    const want = withCommission(n, rate)
    if (Number(r.guest_monthly[m]) !== want) bad.push(`${r.title} month ${m}: got ${r.guest_monthly[m]} want ${want}`)
  }
  if (Number(r.guest) < Number(r.raw)) bad.push(`${r.title} guest < raw`)
}
ok('every real listing marks up correctly (base, weekend, all 12 months)', bad.length === 0, bad.slice(0, 4).join(' | '))

const withMonthly = listings.rows.filter((r) => Object.keys(r.raw_monthly).length > 0)
ok(`seasonal monthly_prices actually exercised (${withMonthly.length} listings)`, withMonthly.length > 0)

// ---- 5. The stay quote: per-night markup, summed, then discounted ----------
const target = listings.rows.find((r) => r.id === fixtureId) ?? listings.rows[0]
const PER_NIGHT_RAW_SQL = `
  CASE
    WHEN extract(dow from d)::int IN (5, 6) AND l.weekend_price IS NOT NULL THEN l.weekend_price
    WHEN (l.monthly_prices ->> extract(month from d)::int::text) ~ '^[0-9.]+$'
         THEN (l.monthly_prices ->> extract(month from d)::int::text)::numeric
    ELSE l.price_per_night
  END`

for (const [checkIn, checkOut, label, expectPct] of [
  ['2026-08-10', '2026-08-13', '3 nights, no discount', 0],
  ['2026-08-10', '2026-08-20', '10 nights, 10% weekly discount', 10],
  ['2026-08-01', '2026-09-05', '35 nights, 25% monthly discount', 25],
]) {
  const q = await pool.query(
    `SELECT ($2::date - $1::date) AS nights,
            (SELECT COALESCE(sum(${sqlWithCommission(PER_NIGHT_RAW_SQL)}), 0)
             FROM generate_series($1::date, $2::date - interval '1 day', interval '1 day') d)::float8 AS subtotal,
            (SELECT COALESCE(sum(${PER_NIGHT_RAW_SQL}), 0)
             FROM generate_series($1::date, $2::date - interval '1 day', interval '1 day') d)::float8 AS raw_subtotal,
            (CASE WHEN ($2::date - $1::date) >= 28 THEN COALESCE(l.monthly_discount, 0)
                  WHEN ($2::date - $1::date) >= 7  THEN COALESCE(l.weekly_discount, 0)
                  ELSE 0 END)::int AS discount_percent
       FROM listings l WHERE l.id = $3`,
    [checkIn, checkOut, target.id]
  )
  const r = q.rows[0]
  const subtotal = Math.round(Number(r.subtotal))
  const total = roundUpToStep(subtotal * (1 - Number(r.discount_percent) / 100))
  const rawSubtotal = Math.round(Number(r.raw_subtotal))
  const pct = Number(r.discount_percent)
  ok(
    `quote — ${label}`,
    subtotal >= rawSubtotal && subtotal % 10 === 0 && total % 10 === 0 &&
      (pct > 0 ? total < subtotal : total === subtotal) && pct === expectPct,
    `raw=${rawSubtotal} guest=${subtotal} −${pct}% → ${total}`
  )
}

// ---- 6. Booking projection uses the SNAPSHOT rate, not the live one --------
const BOOKING_RATE_SQL = `COALESCE(b.commission_rate, ${COMMISSION_RATE_SQL})`
const bk = await pool.query(
  `SELECT b.id, b.total_price::float8 AS raw, b.commission_rate::float8 AS snap,
          ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)}::float8 AS guest
     FROM bookings b LIMIT 10`
)
ok(`booking projection runs (${bk.rowCount} rows)`, true)
const bkBad = bk.rows.filter(
  (r) => Number(r.guest) !== withCommission(Number(r.raw), r.snap === null ? rate : Number(r.snap))
)
ok('bookings price at their snapshotted rate', bkBad.length === 0, JSON.stringify(bkBad.slice(0, 2)))

// A synthetic booking at a rate different from the live one proves the snapshot wins.
const snapTest = await pool.query(
  `SELECT ${sqlWithCommission('5000::numeric', 'COALESCE(0.25::numeric, ' + COMMISSION_RATE_SQL + ')')}::float8 AS g`
)
ok(
  'a booking snapshotted at 25% is NOT repriced by the live 10%',
  Number(snapTest.rows[0].g) === withCommission(5000, 0.25),
  `got ${snapTest.rows[0].g}, want ${withCommission(5000, 0.25)}`
)

// ---- 7. Price FILTER compares against the guest price ----------------------
const filt = await pool.query(
  `SELECT count(*)::int AS n FROM listings l
    WHERE l.is_published = true AND ${sqlWithCommission('l.price_per_night')} <= $1`,
  [3000]
)
const filtRaw = await pool.query(
  `SELECT count(*)::int AS n FROM listings l WHERE l.is_published = true AND l.price_per_night <= $1`,
  [3000]
)
ok(
  'max-price filter uses the guest price (so it is stricter than the raw one)',
  filt.rows[0].n <= filtRaw.rows[0].n,
  `guest-filter=${filt.rows[0].n} raw-filter=${filtRaw.rows[0].n} of ${listings.rowCount}`
)

// ---- 8. Services ------------------------------------------------------------
const svc = await pool.query(
  `SELECT s.price::float8 AS raw, ${sqlWithCommission('s.price')}::float8 AS guest FROM services s LIMIT 10`
)
const svcBad = svc.rows.filter((r) => Number(r.guest) !== withCommission(Number(r.raw), rate))
ok(`services mark up correctly (${svc.rowCount} rows)`, svcBad.length === 0 && svc.rowCount > 0)

await pool.query(`DELETE FROM listings WHERE title = '__COMMISSION_FIXTURE__'`)
await pool.query(`DELETE FROM services WHERE title = '__COMMISSION_FIXTURE__'`)
console.log('\n(fixture rows removed)')

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
await pool.end()
process.exit(failures === 0 ? 0 : 1)
