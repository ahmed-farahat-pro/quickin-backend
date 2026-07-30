// Add users.country — captured at signup ("where are you from?").
//   node quickin-backend/scripts/migrate-country.mjs
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

;(async () => {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS country text`)
  const a = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='country'`
  )
  console.log('users.country:', a.rowCount ? '✅' : '❌')
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
