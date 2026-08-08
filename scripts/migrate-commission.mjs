// Platform commission (markup pricing model).
//
// Most of this already exists if migrate-analytics.mjs has run — that script
// created bookings.commission_rate and seeded app_settings.platform_commission_rate.
// This migration makes the feature safe to deploy on ANY database, and fixes the
// one gap that matters now that guest prices derive from the snapshot:
//
//   - app_settings                    → created if the DB predates migrate-instapay.
//   - app_settings.platform_commission_rate → seeded to 0.1 if absent.
//   - bookings.commission_rate        → added if absent.
//   - bookings.commission_rate BACKFILLED ON EVERY ROW. migrate-analytics only
//     backfilled PAID bookings, because the rate was then just a reporting field.
//     Under the markup model a guest's total is total_price × (1 + commission_rate),
//     so a NULL on a pending booking would quote that guest the raw host price.
//
// Idempotent — safe to re-run.
//   node quickin-backend/scripts/migrate-commission.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const _cs = databaseUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })

const DDL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- The rate itself, stored as a FRACTION string ('0.1' = 10%).
INSERT INTO app_settings (key, value) VALUES ('platform_commission_rate', '0.1')
  ON CONFLICT (key) DO NOTHING;

-- Snapshot of the rate in force when a booking was taken. Editable settings must
-- never retroactively restate a reservation the guest already agreed to.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS commission_rate numeric(5,4);
`

;(async () => {
  await pool.query(DDL)

  // Backfill with the rate that was in force, NOT the current one: a booking taken
  // before the admin ever touched the rate was priced at the 0.1 the code hardcoded.
  const back = await pool.query(
    `UPDATE bookings SET commission_rate = 0.1 WHERE commission_rate IS NULL`
  )

  const rate = await pool.query(`SELECT value FROM app_settings WHERE key = 'platform_commission_rate'`)
  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='commission_rate'`
  )
  const nulls = await pool.query(
    `SELECT count(*)::int AS n FROM bookings WHERE commission_rate IS NULL`
  )

  console.log('app_settings.platform_commission_rate:', rate.rows[0]?.value ?? '❌ missing')
  console.log('bookings.commission_rate column:', col.rowCount ? '✅' : '❌')
  console.log(`backfilled ${back.rowCount} booking(s); ${nulls.rows[0].n} still NULL`)
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
