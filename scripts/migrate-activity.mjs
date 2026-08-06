// F1/F3/F4 — the activity feed, the live dashboard and the alert centre.
//
// Note what is NOT here: there is no `activity_log` table. Five of the six events the
// feed shows are already recorded as timestamps on rows that exist — users.created_at,
// listings.created_at, bookings.created_at, payment_proofs.submitted_at,
// bookings.cancelled_at — so the feed is a UNION over those rather than a second copy
// that could drift from them. It therefore has full history from the day it ships.
//
// Logins are the one exception: nothing anywhere recorded a user sign-in (no
// last_login_at, no user session table — auth is a stateless JWT), so they need a real
// table. It carries an IP and a user agent, i.e. PII, which is why the 90-day purge in
// the staff-cleanup cron is part of this change and not a follow-up.
//
// The indexes exist because the feed date-windows each UNION branch separately, so
// every branch needs its own timestamp index to avoid sorting a whole table.
// bookings already has idx_bookings_created_at and idx_bookings_cancelled.
//
//   node quickin-backend/scripts/migrate-activity.mjs
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
CREATE TABLE IF NOT EXISTS user_logins (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  method     text NOT NULL,
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_logins_created_idx ON user_logins (created_at DESC);
CREATE INDEX IF NOT EXISTS user_logins_user_idx    ON user_logins (user_id, created_at DESC);

-- One index per feed branch. bookings is already covered.
CREATE INDEX IF NOT EXISTS users_created_idx            ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS listings_created_idx         ON listings (created_at DESC);
CREATE INDEX IF NOT EXISTS payment_proofs_submitted_idx ON payment_proofs (submitted_at DESC);

-- The alert centre counts open reports on every dashboard poll, so keep it partial
-- and tiny rather than indexing every report ever filed.
CREATE INDEX IF NOT EXISTS reports_open_idx ON reports (created_at DESC) WHERE status = 'open';
`

;(async () => {
  await pool.query(DDL)

  const want = [
    'user_logins_created_idx', 'user_logins_user_idx', 'users_created_idx',
    'listings_created_idx', 'payment_proofs_submitted_idx', 'reports_open_idx',
  ]
  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`, [want],
  )
  const found = idx.map((r) => r.indexname)
  for (const w of want) console.log(`${w}:`, found.includes(w) ? '✅' : '❌')

  const { rows: t } = await pool.query(
    `SELECT to_regclass('public.user_logins') IS NOT NULL AS present`,
  )
  console.log('user_logins table:', t[0]?.present ? '✅' : '❌')

  // What the feed will show the moment it ships — the point of deriving rather than
  // recording is that these are non-zero on day one.
  const { rows: c } = await pool.query(
    `SELECT (SELECT count(*) FROM users)::int          AS signups,
            (SELECT count(*) FROM listings)::int       AS listings,
            (SELECT count(*) FROM bookings)::int       AS bookings,
            (SELECT count(*) FROM payment_proofs)::int AS payments,
            (SELECT count(*) FROM user_logins)::int    AS logins`,
  )
  console.log('derivable feed rows already present:', JSON.stringify(c[0]))
  await pool.end()
  if (!t[0]?.present || found.length < want.length) process.exit(1)
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
