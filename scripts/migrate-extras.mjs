// Currency → EGP, listing amenities, and profile fields (age / id document / phone).
//   node quickin-backend/scripts/migrate-extras.mjs
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
-- Listing amenities (wifi, pool, kitchen, …)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS amenities text[] DEFAULT '{}';

-- Profile / verification fields. phone is only ever returned to the user themselves.
ALTER TABLE users ADD COLUMN IF NOT EXISTS age int;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_document text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;

-- Currency → EGP everywhere.
ALTER TABLE listings ALTER COLUMN currency SET DEFAULT 'EGP';
UPDATE listings SET currency = 'EGP' WHERE currency IS NULL OR currency = 'USD';
`

const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  // services may or may not have a currency column depending on history.
  try {
    await pool.query(`ALTER TABLE services ALTER COLUMN currency SET DEFAULT 'EGP'`)
    await pool.query(`UPDATE services SET currency = 'EGP' WHERE currency IS NULL OR currency = 'USD'`)
  } catch (e) {
    console.log('services currency update skipped:', e.message)
  }
  const c = await pool.query(`SELECT count(*)::int AS n FROM listings WHERE currency = 'EGP'`)
  console.log(`✅ amenities + profile fields added; ${c.rows[0].n} listings now EGP`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
