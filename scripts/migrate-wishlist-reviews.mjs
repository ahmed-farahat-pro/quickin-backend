// Wishlist + Reviews/ratings schema.
//  - wishlists: a user saves any listing OR service.
//  - reviews: one star-rating + comment per completed booking; aggregated onto
//    the listing (avg rating + count).
// device_tokens already exists (FCM). Idempotent. Run:
//   cd quickin-backend && node scripts/migrate-wishlist-reviews.mjs
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wishlists (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_type text NOT NULL CHECK (item_type IN ('listing','service')),
      item_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, item_type, item_id)
    )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS wishlists_user_idx ON wishlists(user_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
      rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (booking_id)
    )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS reviews_listing_idx ON reviews(listing_id)`)

  const t = async (name) =>
    (await pool.query(`SELECT to_regclass($1) AS r`, ['public.' + name])).rows[0].r
  console.log('wishlists:', (await t('wishlists')) ? '✅' : '❌')
  console.log('reviews:', (await t('reviews')) ? '✅' : '❌')
  console.log('device_tokens:', (await t('device_tokens')) ? '✅ (exists)' : '❌ missing')
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
