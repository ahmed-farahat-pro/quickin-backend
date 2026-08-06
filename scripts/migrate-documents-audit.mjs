// E2/E3/E4 — make users.verification_status the single source of truth for account
// verification, and support auditing document views.
//
// The problem this fixes: /ops wrote only id_verifications.status, while the mobile
// apps read users.verification_status — which nothing wrote. So every iOS/Android
// verified badge, and host_verified on every listing payload, was permanently false.
// The backfill below is what lights up users who were ALREADY approved; without it
// they would silently start over as unverified.
//
//  - backfill users.verification_status / verified_at from the newest id_verifications
//    row per user (idempotent: only touches rows still reading 'unverified')
//  - index users.verification_status for the /ops status filter (partial — the vast
//    majority of rows are 'unverified' and never queried by status)
//  - index staff_audit_log (target_type, target_id) so "who viewed document X" is not
//    a seq scan, now that document views are logged
//  - grant the new `documents` module to every moderator who already holds
//    `verifications` or `listings`, so nobody loses access they have today
//
//   node quickin-backend/scripts/migrate-documents-audit.mjs
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
CREATE INDEX IF NOT EXISTS staff_audit_log_target_idx ON staff_audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS users_verification_status_idx ON users (verification_status)
  WHERE verification_status <> 'unverified';
`

;(async () => {
  await pool.query(DDL)

  // Backfill: newest submission per user wins. Guarded on 'unverified' so re-running
  // never overwrites a decision an admin has since made in /ops.
  const back = await pool.query(
    `UPDATE users u
        SET verification_status = v.status,
            verified_at = CASE WHEN v.status = 'verified' THEN v.reviewed_at ELSE NULL END
       FROM (SELECT DISTINCT ON (user_id) user_id, status, reviewed_at
               FROM id_verifications ORDER BY user_id, submitted_at DESC) v
      WHERE v.user_id = u.id
        AND COALESCE(u.verification_status, 'unverified') = 'unverified'`
  )

  // The `documents` module is new, so nobody holds it. Anyone who can review IDs or
  // moderate listings could already see documents before this change — granting it
  // keeps their day working instead of silently revoking it.
  const grant = await pool.query(
    `INSERT INTO staff_permissions (staff_id, module)
     SELECT DISTINCT staff_id, 'documents' FROM staff_permissions
      WHERE module IN ('verifications', 'listings')
     ON CONFLICT DO NOTHING`
  )

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE indexname IN ('staff_audit_log_target_idx', 'users_verification_status_idx')`
  )
  const found = idx.rows.map((r) => r.indexname)
  for (const want of ['staff_audit_log_target_idx', 'users_verification_status_idx']) {
    console.log(`${want}:`, found.includes(want) ? '✅' : '❌')
  }
  console.log('users backfilled:', back.rowCount)
  console.log("'documents' module granted to:", grant.rowCount, 'staff')
  const counts = await pool.query(
    `SELECT verification_status, count(*)::int AS n FROM users GROUP BY 1 ORDER BY 1`
  )
  console.log('users by verification_status:', JSON.stringify(counts.rows))
  await pool.end()
  if (found.length < 2) process.exit(1)
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
