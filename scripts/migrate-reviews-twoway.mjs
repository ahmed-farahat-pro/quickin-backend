// S4 — two-way reviews + photos.
//  - reviews.photos: image data-URLs/URLs a guest attaches to a stay review.
//  - guest_reviews: the host's review OF the guest after a completed stay
//    (one per booking). Mirrors `reviews` but subject = the guest.
//   node quickin-backend/scripts/migrate-reviews-twoway.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })

;(async () => {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)

  // Photos on stay reviews (guest → listing).
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS photos text[] DEFAULT '{}'`)

  // Host → guest reviews (one per booking).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guest_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      host_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      guest_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS guest_reviews_guest_idx ON guest_reviews(guest_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS guest_reviews_host_idx ON guest_reviews(host_id)`)

  const has = async (name) =>
    (await pool.query(`SELECT to_regclass($1) AS r`, ['public.' + name])).rows[0].r
  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='reviews' AND column_name='photos'`
  )
  console.log('reviews.photos:', col.rowCount ? '✅' : '❌')
  console.log('guest_reviews:', (await has('guest_reviews')) ? '✅' : '❌')
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
