// Seasonal / variable pricing per listing.
//  - listings.weekend_price: nightly price for weekend nights (Fri + Sat in Egypt).
//  - listings.monthly_prices: jsonb { "1".."12": nightlyPrice } — per-month override.
// Per-night price precedence: weekend_price (weekend night, if set) → monthly
// override for that month (if set) → base price_per_night.
//   node quickin-backend/scripts/migrate-seasonal-pricing.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })

const DDL = `
ALTER TABLE listings ADD COLUMN IF NOT EXISTS weekend_price numeric;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS monthly_prices jsonb NOT NULL DEFAULT '{}'::jsonb;
`

;(async () => {
  await pool.query(DDL)
  const a = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='listings' AND column_name='weekend_price'`
  )
  const b = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='listings' AND column_name='monthly_prices'`
  )
  console.log('listings.weekend_price:', a.rowCount ? '✅' : '❌')
  console.log('listings.monthly_prices:', b.rowCount ? '✅' : '❌')
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
