// S5 — host-set cancellation policy + guest cancellation with mock refund.
//  - listings.cancellation_policy: 'flexible' | 'moderate' | 'strict' (host picks).
//  - bookings.cancelled_at / refund_percent / refund_amount: recorded when a
//    guest cancels (refund is mock — there's no real gateway yet).
//   node quickin-backend/scripts/migrate-cancellation.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })

const DDL = `
ALTER TABLE listings ADD COLUMN IF NOT EXISTS cancellation_policy text NOT NULL DEFAULT 'moderate';
ALTER TABLE bookings  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE bookings  ADD COLUMN IF NOT EXISTS refund_percent int;
ALTER TABLE bookings  ADD COLUMN IF NOT EXISTS refund_amount numeric;
`

;(async () => {
  await pool.query(DDL)
  const a = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='listings' AND column_name='cancellation_policy'`
  )
  const b = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='refund_percent'`
  )
  console.log('listings.cancellation_policy:', a.rowCount ? '✅' : '❌')
  console.log('bookings.refund fields:', b.rowCount ? '✅' : '❌')
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
