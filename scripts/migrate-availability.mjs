// Host-set blocked date ranges per listing (manual availability blocks). Booked
// dates are derived from non-cancelled bookings; this table is for ranges a host
// closes off manually (maintenance, personal use…).
//   node quickin-backend/scripts/migrate-availability.mjs
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
CREATE TABLE IF NOT EXISTS listing_blocked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date > start_date)
);
CREATE INDEX IF NOT EXISTS idx_blocked_dates_listing ON listing_blocked_dates(listing_id);
`

const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  const c = await pool.query('SELECT count(*)::int AS n FROM listing_blocked_dates')
  console.log(`✅ listing_blocked_dates ready (${c.rows[0].n} existing rows)`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
