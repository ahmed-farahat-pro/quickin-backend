// Signup identity (2026-11-13): every account created from now on gives a phone
// number and an ID document at signup — see src/lib/local/signup-identity-core.ts.
//   node quickin-backend/scripts/migrate-signup-identity.mjs
// Idempotent. Apply to Neon BEFORE deploying the code: signup and the first Google
// sign-in WRITE users.identity_required, so without the column every new account
// fails with a 500. (Reads degrade — existing accounts keep working.)
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
  // false for every existing row: the requirement applies to new signups only,
  // and is never back-filled.
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_required boolean NOT NULL DEFAULT false`)
  // phoneTakenByOther — one account per phone. Not UNIQUE: accounts from before
  // the rule may already share a number, and those are left alone.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS users_phone_verified_idx ON users (phone) WHERE email_verified = true`)
  const { rows } = await pool.query(
    `SELECT count(*)::int AS shared FROM (
       SELECT phone FROM users WHERE email_verified = true AND phone IS NOT NULL AND phone <> ''
        GROUP BY phone HAVING count(DISTINCT lower(email)) > 1) t`)
  console.log(`✅ users.identity_required ready (${rows[0].shared} phone numbers already shared by several pre-existing accounts — left as they are)`)
  await pool.end()
})().catch(async (e) => { console.error('FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
