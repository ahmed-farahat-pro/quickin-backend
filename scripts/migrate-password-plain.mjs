// PROTOTYPE-ONLY: adds a plaintext password column so the admin panel can display
// account passwords. This is deliberately insecure (never do this in production) and
// only exists because the admin needs to read test-account passwords. Existing real
// accounts keep null (their password was only ever hashed and can't be recovered);
// the seeded demo accounts are backfilled with their known password.
//   node quickin-backend/scripts/migrate-password-plain.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } })
;(async () => {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_plain text`)
  const r = await pool.query(
    `UPDATE users SET password_plain = 'Demo12345' WHERE lower(email) LIKE '%@demo.quickin.app' AND password_plain IS NULL`
  )
  console.log(`✅ password_plain column ready; backfilled ${r.rowCount} demo account(s) with Demo12345`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
