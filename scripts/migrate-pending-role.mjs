// Adds users.pending_role — the role a verified account is in the middle of
// adding (e.g. a guest registering "as a host"). It stays NULL normally; when a
// verified user registers as a host we set pending_role='host' + an OTP, and
// verify-otp promotes role := pending_role only once the emailed code is entered.
// Run: cd quickin-backend && node scripts/migrate-pending-role.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}

const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })

;(async () => {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_role text`)
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'pending_role'`
  )
  console.log(rows.length ? '✅ users.pending_role ready' : '❌ column missing')
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
