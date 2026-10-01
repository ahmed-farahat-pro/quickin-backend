// Public comments on a listing, with one host reply each (2026-10-02). Replaces
// host ⇄ guest messaging; the old conversations/chat_messages/messages tables
// are left in place, unread, so no history is destroyed.
//   node quickin-backend/scripts/migrate-listing-comments.mjs
// Idempotent. Apply to Neon BEFORE deploying the code that reads the table.
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listing_comments (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id      uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body            text NOT NULL,
      host_reply      text,
      host_replied_at timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      deleted_at      timestamptz
    )`)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS listing_comments_listing_idx
       ON listing_comments (listing_id, created_at DESC) WHERE deleted_at IS NULL`)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS listing_comments_user_idx ON listing_comments (user_id, created_at DESC)`)
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM listing_comments`)
  console.log(`✅ listing_comments ready (${rows[0].n} rows)`)
  await pool.end()
})().catch(async (e) => { console.error('FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
