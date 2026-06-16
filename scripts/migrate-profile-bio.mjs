// Profile bio (avatar_url already exists). node quickin-backend/scripts/migrate-profile-bio.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set')
  return m[1].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } })
;(async () => {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text`)
  console.log('✅ users.bio added')
  await pool.end()
})().catch(async (e) => { console.error('FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
