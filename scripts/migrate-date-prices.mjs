// Per-date nightly prices set from the host calendar. One row per (listing, day);
// the ABSENCE of a row means "this day follows the listing's normal pricing"
// (weekend rate → month rate → base), which is why "reset to default" deletes
// rather than writing the base price.
//   node quickin-backend/scripts/migrate-date-prices.mjs
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
CREATE TABLE IF NOT EXISTS listing_date_prices (
  listing_id uuid    NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  date       date    NOT NULL,
  -- The host's RAW nightly rate for this one night, in the listing's currency.
  -- The guest-facing figure is derived at read time by the commission markup and
  -- is never stored (see commission-core.ts) — changing the platform rate must
  -- reprice every calendar instantly, with nothing to backfill and nothing to drift.
  price      numeric(12,2) NOT NULL CHECK (price > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One price per night. Setting a day the host already priced is an UPSERT, not
  -- a second row — two rows would make the ladder's answer depend on row order.
  PRIMARY KEY (listing_id, date)
);
-- The calendar reads one listing over a date window, and the per-night stay sum
-- probes (listing_id, date) once per night. The primary key already serves both.
CREATE INDEX IF NOT EXISTS idx_date_prices_date ON listing_date_prices(date);
`

const _cs = databaseUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  const c = await pool.query('SELECT count(*)::int AS n FROM listing_date_prices')
  console.log(`✅ listing_date_prices ready (${c.rows[0].n} existing rows)`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
