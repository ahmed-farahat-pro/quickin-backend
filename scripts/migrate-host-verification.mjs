// Host identity verification gate.
//
//   - id_verifications.doc_type   → which document was uploaded (national_id |
//                                   passport | residence_permit). Nullable, so
//                                   rows submitted before this migration stay
//                                   valid; the app requires it on NEW submissions.
//   - host_applications.verification_id → links an application to the ID
//                                   submission made alongside it, so one admin
//                                   decision can approve both.
//
// Then it REPORTS (and changes nothing else): how many approved hosts are not
// identity-verified, and how many published listings they hold. This is a hard
// cutover — those hosts cannot create or publish until they verify — so the
// number should be read BEFORE deploying the gate.
//
// Idempotent — safe to re-run.
//   node quickin-backend/scripts/migrate-host-verification.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const _cs = databaseUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })

const DDL = `
-- Which document the host uploaded. Nullable on purpose: existing submissions
-- predate the field and must not become invalid. New ones are required at the
-- app layer (normalizeDocType throws), not by a NOT NULL that would break them.
ALTER TABLE id_verifications ADD COLUMN IF NOT EXISTS doc_type text;

-- The ID submission made as part of a "become a host" application, so approving
-- the application can approve the identity in the same decision.
ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS verification_id uuid;

-- Only add the FK once, and only if it isn't already there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'host_applications_verification_id_fkey'
  ) THEN
    ALTER TABLE host_applications
      ADD CONSTRAINT host_applications_verification_id_fkey
      FOREIGN KEY (verification_id) REFERENCES id_verifications(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Listings taken down because their host lost verification, so re-verifying puts
-- back exactly those and nothing else.
--
-- Deliberately NOT the existing unpublished_by_admin flag, which the account
-- block/restore flow owns: sharing one flag would let unblocking an account
-- republish listings that verification had hidden (and vice versa). The two
-- reasons compose — a listing hidden for both stays hidden until both clear.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS unpublished_by_verification boolean NOT NULL DEFAULT false;

-- The gate reads users.verification_status on every listing write.
CREATE INDEX IF NOT EXISTS users_verification_status_idx
  ON users (verification_status) WHERE is_host = true;
`

;(async () => {
  await pool.query(DDL)

  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name='id_verifications' AND column_name='doc_type')
         OR (table_name='host_applications' AND column_name='verification_id')`
  )
  const has = (t, c) => cols.rows.some((r) => r.table_name === t && r.column_name === c)
  console.log('id_verifications.doc_type:', has('id_verifications', 'doc_type') ? '✅' : '❌')
  console.log('host_applications.verification_id:', has('host_applications', 'verification_id') ? '✅' : '❌')

  // ---- Cutover blast radius (read-only) -------------------------------------
  const impact = await pool.query(
    `SELECT
       (SELECT count(*) FROM users WHERE is_host = true)::int AS hosts,
       (SELECT count(*) FROM users
         WHERE is_host = true AND COALESCE(verification_status,'unverified') <> 'verified')::int AS unverified_hosts,
       (SELECT count(*) FROM listings l
         WHERE l.is_published = true
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = l.host_id
                        AND u.is_host = true
                        AND COALESCE(u.verification_status,'unverified') <> 'verified'))::int AS their_live_listings`
  )
  const i = impact.rows[0]
  console.log('')
  console.log('--- hard-cutover impact (nothing was changed) ---')
  console.log(`approved hosts:                 ${i.hosts}`)
  console.log(`  of those, NOT verified:       ${i.unverified_hosts}`)
  console.log(`  their published listings:     ${i.their_live_listings}  (stay live; they just cannot add or publish more)`)

  if (Number(i.unverified_hosts) > 0) {
    const who = await pool.query(
      `SELECT u.email, COALESCE(u.verification_status,'unverified') AS status,
              (SELECT count(*) FROM listings l WHERE l.host_id = u.id AND l.is_published = true)::int AS live
         FROM users u
        WHERE u.is_host = true AND COALESCE(u.verification_status,'unverified') <> 'verified'
        ORDER BY live DESC, u.email
        LIMIT 25`
    )
    console.log('')
    console.log('who is blocked (top 25 by live listings):')
    for (const r of who.rows) console.log(`  ${String(r.status).padEnd(10)} ${String(r.live).padStart(3)} live  ${r.email}`)
  }

  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
