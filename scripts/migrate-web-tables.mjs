// Schema owned by the WEB app (quickin-frontend) that has never had a migration
// script anywhere. These tables and columns were applied straight to Neon through
// throwaway key-gated routes (src/app/api/local/xmig4/5/6), which were deleted after
// running — so prod has them, but a fresh database does not, and there was no way to
// rebuild one. Written from the queries in quickin-frontend/src/lib/local/db.ts.
//
//   - users.is_host           → host capability flag the web uses (parallel to users.role)
//   - listings.weekend_days   → which weekdays count as weekend pricing
//   - host_applications       → "become a host" queue the /ops Applications tab reads
//   - id_verifications        → ID document review queue (/ops Verifications tab)
//   - otp_codes               → web email-OTP store (the backend keeps OTPs on the user row)
//   - saved_listings          → wishlist
//   - conversations / chat_messages → guest↔host messaging
//
// Idempotent. Safe against prod (everything is IF NOT EXISTS), and required for any
// fresh/local database.
//   node quickin-backend/scripts/migrate-web-tables.mjs
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
-- Web-side host flag. The backend uses users.role='host'; the web reads this boolean
-- and keeps the two loosely in sync (reviewHostApplication sets both).
ALTER TABLE users    ADD COLUMN IF NOT EXISTS is_host       boolean NOT NULL DEFAULT false;
-- Web push registration (the backend registers into device_tokens instead; the web
-- also reads these two directly in adminListUsers).
ALTER TABLE users    ADD COLUMN IF NOT EXISTS fcm_token     text;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS push_platform text;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS weekend_days  integer[];

-- "Become a host" applications. The /ops Applications tab lists status='pending'
-- and reviewHostApplication() writes reviewed_at / reviewed_by / review_note.
CREATE TABLE IF NOT EXISTS host_applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name    text,
  national_id  text,
  phone        text,
  address      text,
  company      text,
  notes        text,
  status       text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz,
  reviewed_by  text,                              -- TEXT: the legacy admin token has id 'admin'
  review_note  text
);
CREATE INDEX IF NOT EXISTS host_applications_status_idx ON host_applications (status, submitted_at);

-- ID verification submissions. image_data / back_image_data / selfie_image_data are
-- base64 data URLs stored inline, the same convention as listing_images.
CREATE TABLE IF NOT EXISTS id_verifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name         text,
  id_number         text,
  image_data        text NOT NULL,
  back_image_data   text,
  selfie_image_data text,
  source            text,
  status            text NOT NULL DEFAULT 'pending',   -- pending | verified | rejected
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at       timestamptz,
  reviewed_by       text,
  notes             text
);
CREATE INDEX IF NOT EXISTS id_verifications_status_idx ON id_verifications (status, submitted_at);

-- Web email-OTP store. (The backend keeps its OTP on users.otp_code instead — the two
-- apps deliberately differ here.)
CREATE TABLE IF NOT EXISTS otp_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  code       text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_email_idx ON otp_codes (lower(email), created_at DESC);

-- Wishlist. One row per (user, listing).
CREATE TABLE IF NOT EXISTS saved_listings (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

-- Guest <-> host messaging, one conversation per (listing, guest).
CREATE TABLE IF NOT EXISTS conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid REFERENCES listings(id) ON DELETE CASCADE,
  guest_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_listing_guest_uidx ON conversations (listing_id, guest_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages (conversation_id, created_at);

-- Existing hosts get the web flag so they don't lose host access on a DB that
-- predates is_host. Guarded, so it never re-runs over manual edits.
UPDATE users SET is_host = true WHERE role = 'host' AND is_host = false;
`

const url = databaseUrl()
const isLocal = url.includes('127.0.0.1') || url.includes('localhost')
const pool = new pg.Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
  await pool.query(DDL)

  const { rows } = await pool.query(
    `SELECT t AS name, to_regclass('public.' || t) IS NOT NULL AS present
       FROM unnest(ARRAY['host_applications','id_verifications','otp_codes',
                         'saved_listings','conversations','chat_messages']) AS t`
  )
  const missing = rows.filter((r) => !r.present).map((r) => r.name)
  if (missing.length) throw new Error(`tables missing after DDL: ${missing.join(', ')}`)

  const cols = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE (table_name='users' AND column_name IN ('is_host','fcm_token','push_platform'))
         OR (table_name='listings' AND column_name='weekend_days')`
  )
  console.log(`✅ web tables ready — 6 tables, ${cols.rows[0].n}/4 added columns`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
