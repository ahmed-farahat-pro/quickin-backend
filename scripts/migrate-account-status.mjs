// D3/D4 — account status: block (suspend) and remove (soft-delete) a user.
//  - users.account_status: 'active' | 'blocked' | 'removed'. One column rather than
//    two flags, so every enforcement site tests one thing and the two states can
//    never both be true. Existing rows backfill to 'active' (DEFAULT).
//  - users.status_reason / status_changed_at / status_changed_by: who did it and why.
//    status_changed_by holds `staff:<uuid>`, the same free-text actor convention as
//    payment_proofs.reviewed_by and app_settings.updated_by.
//  - listings.unpublished_by_admin: marks the listings a removal hid, so a restore
//    republishes EXACTLY those and leaves a listing the host unpublished themselves
//    alone. Without it, "hide their listings" is a one-way door.
//   node quickin-backend/scripts/migrate-account-status.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const _cs = dbUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })

const DDL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_changed_by text;

ALTER TABLE listings ADD COLUMN IF NOT EXISTS unpublished_by_admin boolean NOT NULL DEFAULT false;

-- The /ops users list filters on status and searches email + name.
CREATE INDEX IF NOT EXISTS users_account_status_idx ON users (account_status);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email) text_pattern_ops);
CREATE INDEX IF NOT EXISTS users_full_name_lower_idx ON users (lower(full_name) text_pattern_ops);
-- Restore needs to find the rows a removal hid, per host.
CREATE INDEX IF NOT EXISTS listings_unpublished_by_admin_idx ON listings (host_id) WHERE unpublished_by_admin = true;
`

;(async () => {
  await pool.query(DDL)
  // Belt-and-suspenders: a NULL status would fail every `= 'active'` gate and lock
  // the account out. The column is NOT NULL, but an older partial run may have added
  // it without the default.
  await pool.query(`UPDATE users SET account_status = 'active' WHERE account_status IS NULL OR account_status = ''`)

  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'users' AND column_name IN ('account_status','status_reason','status_changed_at','status_changed_by'))
         OR (table_name = 'listings' AND column_name = 'unpublished_by_admin')`
  )
  const found = cols.rows.map((r) => `${r.table_name}.${r.column_name}`)
  const want = [
    'users.account_status', 'users.status_reason', 'users.status_changed_at',
    'users.status_changed_by', 'listings.unpublished_by_admin',
  ]
  for (const c of want) console.log(`${c}:`, found.includes(c) ? '✅' : '❌')

  const counts = await pool.query(`SELECT account_status, count(*)::int AS n FROM users GROUP BY account_status`)
  console.log('users by status:', JSON.stringify(counts.rows))
  await pool.end()
  if (want.some((c) => !found.includes(c))) process.exit(1)
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
