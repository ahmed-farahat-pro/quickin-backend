// Instapay manual-payment schema:
//   - app_settings   → admin-editable key/value config (holds the Instapay handle)
//   - payment_proofs → the transfer screenshots a guest uploads, one row per
//                      submission (keeps re-upload + dispute history)
// Bookings keep payment_status as the rollup: 'submitted' → 'paid' | 'rejected' | 'disputed'.
//   node quickin-backend/scripts/migrate-instapay.mjs
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
-- Admin-editable key/value config. Seeded with an empty Instapay handle so the
-- read path never 404s; the admin fills it in from the ops panel.
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
INSERT INTO app_settings (key, value) VALUES ('instapay_handle', '')       ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('instapay_instructions', '') ON CONFLICT (key) DO NOTHING;
-- The deep link and the uploaded QR image are optional companions to the handle.
-- Seeding them is a convenience only: getPaymentConfig() reads a missing row as
-- '' and setSetting() upserts, so an already-migrated database needs nothing.
INSERT INTO app_settings (key, value) VALUES ('instapay_link', '')         ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('instapay_qr_image', '')     ON CONFLICT (key) DO NOTHING;

-- One row per uploaded transfer screenshot. image_data is a base64 data URL
-- (same inline-image convention as id_verifications / listing_images).
-- reviewed_by is TEXT (not a users FK) because the hardcoded admin token has id 'admin'.
CREATE TABLE IF NOT EXISTS payment_proofs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  method        text NOT NULL DEFAULT 'instapay',
  image_data    text NOT NULL,
  amount        numeric,
  status        text NOT NULL DEFAULT 'submitted',   -- submitted | approved | rejected | disputed
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by   text,
  reviewed_at   timestamptz,
  reject_reason text,
  dispute_note  text,
  disputed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_booking ON payment_proofs (booking_id);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_status  ON payment_proofs (status);
`

const _cs = databaseUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  const s = await pool.query(`SELECT count(*)::int AS n FROM app_settings`)
  const p = await pool.query(`SELECT count(*)::int AS n FROM payment_proofs`)
  console.log(`✅ instapay schema ready — app_settings (${s.rows[0].n} keys), payment_proofs (${p.rows[0].n} rows)`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
