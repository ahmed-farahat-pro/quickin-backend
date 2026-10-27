// Host response alerts (2026-10-22): one row per booking request a host has left
// unanswered for more than 24h. Written by the nightly sweep
// (GET /api/cron/host-response-alerts), worked by staff at /ops/host-response.
//   node quickin-backend/scripts/migrate-host-response-alerts.mjs
// Idempotent. Apply to Neon BEFORE deploying the code that reads the table — the
// alert centre degrades to 0 without it, but the cron and the ops screen 500.
import pg from 'pg'
import { readFileSync } from 'node:fs'
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set')
  return m[1].trim().replace(/^["']|["']$/g, '')
}
const _cs = databaseUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  // One row per booking, ever: a request that goes quiet, gets answered, and is
  // reopened to pending (a guest re-uploading after a decline) reuses its row
  // rather than stacking duplicates. host_id is a snapshot so the history survives
  // a listing changing hands.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS host_response_alerts (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id      uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      host_id         uuid REFERENCES users(id) ON DELETE SET NULL,
      status          text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'handled', 'resolved', 'expired')),
      first_flagged_at timestamptz NOT NULL DEFAULT now(),
      last_flagged_at  timestamptz NOT NULL DEFAULT now(),
      nudge_count     int NOT NULL DEFAULT 0,
      last_nudged_at  timestamptz,
      handled_by      text,
      handled_by_name text,
      handled_at      timestamptz,
      handled_note    text,
      closed_at       timestamptz,
      closed_reason   text
    )`)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS host_response_alerts_status_idx
       ON host_response_alerts (status, first_flagged_at)`)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS host_response_alerts_host_idx ON host_response_alerts (host_id)`)
  // The sweep's candidate scan: pending requests by age.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS bookings_pending_created_idx
       ON bookings (created_at) WHERE status = 'pending'`)
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM host_response_alerts`)
  console.log(`✅ host_response_alerts ready (${rows[0].n} rows)`)
  await pool.end()
})().catch(async (e) => { console.error('FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
