// S6 — trust & safety: identity verification + reports.
//  - users.verification_status: 'unverified' | 'pending' | 'verified' | 'rejected'
//  - users.verification_doc: data-URL of the submitted ID image (prototype).
//  - users.verified_at: when an admin approved.
//  - reports: a user reports a listing / user / review; staff triage in admin.
//   node quickin-backend/scripts/migrate-trust.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })

const DDL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified';
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_doc text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('listing','user','review')),
  target_id uuid NOT NULL,
  reason text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status);
CREATE INDEX IF NOT EXISTS reports_target_idx ON reports(target_type, target_id);
`

;(async () => {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
  await pool.query(DDL)
  const a = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='verification_status'`
  )
  const b = await pool.query(`SELECT to_regclass('public.reports') AS r`)
  console.log('users.verification_status:', a.rowCount ? '✅' : '❌')
  console.log('reports table:', b.rows[0].r ? '✅' : '❌')
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
