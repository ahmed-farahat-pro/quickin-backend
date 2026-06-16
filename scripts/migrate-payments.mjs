// Mock-payment fields on bookings (no real gateway yet — Paymob comes later).
//   node quickin-backend/scripts/migrate-payments.mjs
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
-- Payment state for a booking. 'unpaid' until the (currently mocked) checkout
-- succeeds; then 'paid'. payment_method = 'mock' for now; swap for 'paymob' later.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_ref text;
-- Backfill any legacy rows so reads never return null status.
UPDATE bookings SET payment_status = 'unpaid' WHERE payment_status IS NULL;
`

const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  const c = await pool.query(`SELECT count(*)::int AS n FROM bookings`)
  console.log(`✅ payment fields added to bookings (${c.rows[0].n} rows)`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
