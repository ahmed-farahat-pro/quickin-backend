// Flash (useflash.app) automatic payments — one row per checkout attempt.
//   node quickin-backend/scripts/migrate-flash.mjs
//
// A booking can have several attempts (a link expired, the price changed), so
// this is its own table rather than columns on bookings. The booking keeps the
// rollup it always had: payment_status 'paid' + paid_at + payment_method 'flash'.
// Idempotent — safe to re-run.
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
;(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flash_orders (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id          uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      user_id             uuid NOT NULL,
      -- OUR id for the attempt, sent to Flash as aggregatorOrderId. Unique, so a
      -- webhook names exactly one row.
      aggregator_order_id text NOT NULL UNIQUE,
      -- Flash's own order uuid, learned from the create response.
      flash_order_id      text,
      amount_cents        integer NOT NULL,
      currency            text NOT NULL DEFAULT 'EGP',
      payment_link        text,
      -- pending | processing | succeeded | failed | canceled | refunded | expired
      status              text NOT NULL DEFAULT 'pending',
      paid_amount_cents   integer,
      expires_at          timestamptz,
      paid_at             timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      -- The last signed webhook body, kept for reconciliation with Flash's dashboard.
      last_event          jsonb
    )`)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS flash_orders_booking_idx ON flash_orders (booking_id, created_at DESC)`)
  // New method, so OFF until an admin switches it on in /ops/payments — unlike
  // Instapay and bank transfer, whose missing toggle reads as on.
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('flash_enabled', '0') ON CONFLICT (key) DO NOTHING`)
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM flash_orders`)
  console.log(`✅ flash_orders ready (${rows[0].n} rows)`)
  await pool.end()
})().catch(async (e) => { console.error('FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
