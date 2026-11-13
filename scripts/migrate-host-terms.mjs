// Host terms on the become-a-host application (2026-11-13): the applicant accepts
// the host terms, and the version + time are kept on the application.
//   node quickin-backend/scripts/migrate-host-terms.mjs
// Idempotent. Apply to Neon BEFORE deploying the code: POST /api/local/host/apply
// WRITES these columns, so without them every application fails with a 500.
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
  // NULL on every existing application: they were filed before there were terms.
  await pool.query(`ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS terms_version text`)
  await pool.query(`ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz`)
  console.log('✅ host_applications.terms_version / terms_accepted_at ready')
  await pool.end()
})().catch(async (e) => { console.error('FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
