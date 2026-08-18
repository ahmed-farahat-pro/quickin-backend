// Indexes for the search ranking (see README → "Search ranking").
//
// The `recommended` order derives its score at read time, which costs three
// correlated subqueries per listing: two over `reviews`, one over `bookings`.
// Both already filter on the listing id, so these two indexes turn each of them
// from a sequential scan into a lookup. Nothing about the FEATURE depends on this
// migration — the ranking is correct without it — it only keeps search fast as
// the catalogue grows.
//
//   node quickin-backend/scripts/migrate-ranking-indexes.mjs
//
// Safe to re-run (IF NOT EXISTS) and safe to run before the code deploys.
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const DDL = `
-- Both review subqueries: WHERE listing_id = l.id, reading rating + created_at.
CREATE INDEX IF NOT EXISTS idx_reviews_listing_ranking
  ON reviews(listing_id) INCLUDE (rating, created_at);

-- The completed-stay subquery: WHERE listing_id = l.id AND status/check_out.
CREATE INDEX IF NOT EXISTS idx_bookings_listing_ranking
  ON bookings(listing_id, status, check_out);
`

const _cs = databaseUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_ranking' ORDER BY indexname`
  )
  console.log(`✅ ranking indexes ready: ${rows.map((r) => r.indexname).join(', ') || 'none'}`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
