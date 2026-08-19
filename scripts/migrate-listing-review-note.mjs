// listings.review_note — the operator's reason for rejecting a listing, so the host
// can read it (see README → "A rejected listing has to say why").
//
// The reason used to exist only inside a notification body: /ops prompted for it,
// setListingApproval interpolated it into the message, and nothing stored it. A host
// who missed that one notification saw a "Rejected" badge with no way to learn what
// to fix. This column is where it lives now, and the host projection
// (LISTING_COLS_HOST) reads it back for the web dashboard and both mobile apps.
//
//   node quickin-backend/scripts/migrate-listing-review-note.mjs
//
// Safe to re-run (IF NOT EXISTS). Nullable with no default and NO backfill: NULL means
// "no reason recorded", which is the honest answer both for a rejection the operator
// left unexplained (the note is optional) and for every listing rejected before this
// column existed — those reasons were never stored anywhere recoverable.
//
// RUN IT BEFORE DEPLOYING. Unlike most additive columns this one is read immediately:
// the host projection selects it, so on a database without the column every host read
// fails. Guest reads never touch it.
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const DDL = `
ALTER TABLE listings ADD COLUMN IF NOT EXISTS review_note text;
`

const _cs = databaseUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  const { rows } = await pool.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'listings' AND column_name = 'review_note'`
  )
  if (!rows.length) throw new Error('listings.review_note is still missing after the ALTER')
  // How many hosts are sitting on a rejection with no recoverable reason — they will
  // see the generic "needs changes" copy until their listing is rejected again.
  const { rows: orphaned } = await pool.query(
    `SELECT count(*)::int AS n FROM listings
      WHERE approval_status = 'rejected' AND review_note IS NULL`
  )
  console.log(`✅ listings.review_note ready (${rows[0].data_type})`)
  console.log(`ℹ️  ${orphaned[0].n} already-rejected listing(s) carry no reason — generic copy applies to those`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
