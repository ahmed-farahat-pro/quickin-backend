// Staff RBAC schema — a super admin + moderators for the /ops admin panel, kept
// entirely separate from the `users` table (which is guests/hosts). Mirrors the
// HubDrives model: one super admin, super-admin-created moderators, per-module
// permissions, enforced on both the screen and the API.
//   - staff_accounts        → the accounts themselves (role, is_active, lockout counters)
//   - staff_permissions     → which modules a moderator may use (super admin needs no rows)
//   - staff_sessions        → DB-backed, revocable sessions (so deactivating kills live logins)
//   - staff_password_resets → 6-digit reset codes: 15 min, single-use, max 5 wrong tries
//   - staff_audit_log       → who did what, incl. failed logins and lockouts
// The module catalog itself lives in code (STAFF_MODULES in src/lib/local/staff.ts,
// duplicated in the frontend repo) — a module only exists if there's a route to gate,
// so `staff_permissions.module` is a plain text key validated against that constant.
//   node quickin-backend/scripts/migrate-staff-rbac.mjs
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
-- Staff (admin panel) accounts. Deliberately NOT the users table: users.role is
-- already overloaded ('host' is written by the host-approval flow in parallel with
-- the is_host boolean), so a staff role there would collide. password_hash is the
-- same scrypt 'salt:hash' format as users.password_hash — and unlike users there is
-- NO plaintext column here, ever.
CREATE TABLE IF NOT EXISTS staff_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  password_hash         text NOT NULL,
  full_name             text NOT NULL,
  role                  text NOT NULL DEFAULT 'moderator',   -- 'super_admin' | 'moderator'
  is_active             boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES staff_accounts(id) ON DELETE SET NULL,
  last_login_at         timestamptz,
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness. NB: users has a (lower(email), role) index instead,
-- a leftover of the abandoned guest/host split — staff email is unique outright.
CREATE UNIQUE INDEX IF NOT EXISTS staff_accounts_email_uidx ON staff_accounts (lower(email));

-- One row per module a moderator may access. A super admin has no rows and is
-- allowed everything (see staffCan). Deleting the account cascades.
CREATE TABLE IF NOT EXISTS staff_permissions (
  staff_id   uuid NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  module     text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES staff_accounts(id) ON DELETE SET NULL,
  PRIMARY KEY (staff_id, module)
);

-- Sessions are rows, not stateless claims, so they can be REVOKED: deactivating a
-- moderator or changing a password kills their live logins immediately. id is the
-- "sid" claim inside the qk_staff token. last_seen_at drives the idle timeout and is
-- written at most once every 2 minutes per session (this DB is shared — unthrottled,
-- every admin request would become a write).
CREATE TABLE IF NOT EXISTS staff_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS staff_sessions_staff_idx  ON staff_sessions (staff_id);
CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx ON staff_sessions (expires_at);

-- 6-digit reset codes. Single-use (used_at), 15-minute default expiry, and locked
-- after 5 wrong guesses. Code is plaintext, matching the existing users OTP convention.
CREATE TABLE IF NOT EXISTS staff_password_resets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id        uuid NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  email           text NOT NULL,
  code            text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  failed_attempts int NOT NULL DEFAULT 0,
  request_ip      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_password_resets_staff_idx ON staff_password_resets (staff_id);

-- Admin action trail. staff_email is denormalized so a row stays readable after the
-- account is deleted (staff_id then nulls out). detail is free-form jsonb.
CREATE TABLE IF NOT EXISTS staff_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid REFERENCES staff_accounts(id) ON DELETE SET NULL,
  staff_email text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_audit_log_created_idx ON staff_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS staff_audit_log_staff_idx   ON staff_audit_log (staff_id);
`

// Managed Postgres (Neon) needs TLS; a local instance doesn't offer it. Same test
// src/lib/local/pool.ts uses, so this script can also run against a local DB.
const url = databaseUrl()
const isLocal = url.includes('127.0.0.1') || url.includes('localhost')
const pool = new pg.Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  // gen_random_uuid() lives in pgcrypto; users already relies on it, but be explicit.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
  await pool.query(DDL)

  const { rows } = await pool.query(
    `SELECT to_regclass('public.' || t) IS NOT NULL AS present, t
       FROM unnest(ARRAY['staff_accounts','staff_permissions','staff_sessions',
                         'staff_password_resets','staff_audit_log']) AS t`
  )
  const missing = rows.filter((r) => !r.present).map((r) => r.t)
  if (missing.length) throw new Error(`tables missing after DDL: ${missing.join(', ')}`)

  const a = await pool.query(`SELECT count(*)::int AS n FROM staff_accounts`)
  const s = await pool.query(`SELECT count(*)::int AS n FROM staff_accounts WHERE role = 'super_admin' AND is_active`)
  console.log(`✅ staff rbac schema ready — 5 tables, staff_accounts (${a.rows[0].n} rows, ${s.rows[0].n} active super admin)`)
  if (s.rows[0].n === 0) {
    console.log('   next: SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... node scripts/seed-superadmin.mjs')
  }
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
