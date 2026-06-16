// S7 — listing approval queue + ownership documents.
//  - listings.approval_status: 'pending' | 'approved' | 'rejected'.
//    Existing rows backfill to 'approved' (DEFAULT) so they stay live; NEW
//    listings are created 'pending' + unpublished (in code) and need admin OK.
//  - listings.ownership_doc: a data-URL the host uploads as proof of ownership /
//    right-to-rent (reviewed by staff; never returned in public listing data).
//   node quickin-backend/scripts/migrate-listing-approval.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })

const DDL = `
ALTER TABLE listings ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS ownership_doc text;
`

;(async () => {
  await pool.query(DDL)
  // Belt-and-suspenders: ensure every currently-published listing is 'approved'.
  await pool.query(`UPDATE listings SET approval_status = 'approved' WHERE is_published = true AND approval_status IS DISTINCT FROM 'approved'`)
  const a = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='listings' AND column_name='approval_status'`
  )
  const counts = await pool.query(`SELECT approval_status, count(*)::int AS n FROM listings GROUP BY approval_status`)
  console.log('listings.approval_status:', a.rowCount ? '✅' : '❌')
  console.log('by status:', JSON.stringify(counts.rows))
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
