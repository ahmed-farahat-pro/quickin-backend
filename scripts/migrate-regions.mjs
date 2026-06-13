// Adds listings.region — a coarse, searchable area the host picks first (North
// Coast / Ain Sokhna / El Gouna), separate from the precise pin. Backfills the
// region for existing listings from their location text. Idempotent.
// Run: cd quickin-backend && node scripts/migrate-regions.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })

// location ILIKE pattern -> canonical region label. First match wins.
const RULES = [
  ['Ain Sokhna', ['%sokhna%']],
  ['El Gouna', ['%gouna%']],
  ['North Coast', ['%north coast%', '%sahel%', '%alamein%', '%sidi abdel%', '%marassi%', '%marina%']],
  ['Cairo', ['%cairo%', '%giza%', '%zamalek%', '%maadi%', '%new cairo%']],
]

;(async () => {
  await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS region text`)
  for (const [region, patterns] of RULES) {
    const ors = patterns.map((_, i) => `location ILIKE $${i + 2}`).join(' OR ')
    const res = await pool.query(
      `UPDATE listings SET region = $1 WHERE region IS NULL AND (${ors})`,
      [region, ...patterns]
    )
    console.log(`  ${region}: tagged ${res.rowCount}`)
  }
  const { rows } = await pool.query(
    `SELECT COALESCE(region, '(none)') AS region, count(*)::int AS n FROM listings GROUP BY 1 ORDER BY 2 DESC`
  )
  console.log('\nRegion distribution:')
  rows.forEach((r) => console.log(`  ${r.region}: ${r.n}`))
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
