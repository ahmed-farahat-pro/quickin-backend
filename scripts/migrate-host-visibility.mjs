// Host-controlled visibility — "delete my listing" without deleting anything.
//
// A host had no way at all to take a listing off the market: no delete, no hide,
// nothing. This adds the fourth (and last) reason a row can be unpublished:
//
//   listings.unpublished_by_host  → the HOST took this listing down themselves.
//   services.unpublished_by_host  → same, for a host's standalone service.
//
// Deliberately its own flag rather than reusing unpublished_by_admin or
// unpublished_by_verification, for the same reason those two are separate: each
// party may only release its own grip. A listing an operator hid must not come
// back because the host pressed a button, and a listing the host hid must not
// come back because an account block was lifted. The four reasons compose — the
// listing stays down until every one of them clears. See
// src/lib/local/host-visibility-core.ts for the whole rule set.
//
// NOTHING is backfilled. Every existing unpublished row keeps
// unpublished_by_host = false, which reads as "the host did not hide this" — true
// for all of them, since until now they could not. The practical effect is that
// a listing an operator or the ID gate has down stays down, and the host is
// offered no reactivate button for it, which is exactly right.
//
// Idempotent — safe to re-run.
//   node quickin-backend/scripts/migrate-host-visibility.mjs
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
-- The host's own takedown. NOT NULL DEFAULT false so every existing row reads
-- "the host did not hide this", which is factually true — there was no way for
-- them to until now.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS unpublished_by_host boolean NOT NULL DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS unpublished_by_host boolean NOT NULL DEFAULT false;

-- Partial, host-keyed: the only queries that care are "which of THIS host's rows
-- did they hide", and the flag is false on the overwhelming majority of rows.
CREATE INDEX IF NOT EXISTS listings_unpublished_by_host_idx
  ON listings (host_id) WHERE unpublished_by_host = true;
CREATE INDEX IF NOT EXISTS services_unpublished_by_host_idx
  ON services (host_id) WHERE unpublished_by_host = true;
`

;(async () => {
  await pool.query(DDL)

  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE column_name = 'unpublished_by_host'
        AND table_name IN ('listings', 'services')`
  )
  const has = (t) => cols.rows.some((r) => r.table_name === t)
  console.log('listings.unpublished_by_host:', has('listings') ? '✅' : '❌')
  console.log('services.unpublished_by_host:', has('services') ? '✅' : '❌')

  // ---- What hosts will see the moment this ships (read-only) ----------------
  // Every unpublished row is now attributable. "unexplained" is the flagless
  // operator takedown — adminSetListingPublished(id, false) writes no flag on
  // purpose — plus anything unpublished before the flags existed. Those show the
  // host a "hidden by our team" badge and no reactivate button, which is the
  // intended outcome, but the count is worth reading before the deploy.
  const impact = await pool.query(
    `SELECT
       (SELECT count(*) FROM listings WHERE is_published = true)::int AS live,
       (SELECT count(*) FROM listings WHERE is_published = false)::int AS down,
       (SELECT count(*) FROM listings
         WHERE is_published = false
           AND COALESCE(approval_status,'approved') = 'pending')::int AS in_queue,
       (SELECT count(*) FROM listings
         WHERE is_published = false
           AND COALESCE(approval_status,'approved') = 'rejected')::int AS rejected,
       (SELECT count(*) FROM listings WHERE unpublished_by_admin = true)::int AS by_block,
       (SELECT count(*) FROM listings WHERE unpublished_by_verification = true)::int AS by_id_gate,
       (SELECT count(*) FROM listings
         WHERE is_published = false
           AND COALESCE(approval_status,'approved') = 'approved'
           AND COALESCE(unpublished_by_admin, false) = false
           AND COALESCE(unpublished_by_verification, false) = false)::int AS unexplained,
       (SELECT count(*) FROM services WHERE is_published = false)::int AS services_down`
  )
  const i = impact.rows[0]
  console.log('')
  console.log('--- listing visibility today (nothing was changed) ---')
  console.log(`live:                           ${i.live}`)
  console.log(`unpublished:                    ${i.down}`)
  console.log(`  waiting on review:            ${i.in_queue}`)
  console.log(`  rejected:                     ${i.rejected}`)
  console.log(`  hidden by an account block:   ${i.by_block}`)
  console.log(`  hidden by the identity gate:  ${i.by_id_gate}`)
  console.log(`  approved but down, no flag:   ${i.unexplained}  (manual /ops takedowns — host sees "hidden by our team", no reactivate)`)
  console.log(`services unpublished:           ${i.services_down}`)

  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
