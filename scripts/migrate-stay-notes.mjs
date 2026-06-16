// Host-attachable notes on a booking — surfaced on the public "stay pass" page
// that each reservation's QR links to.
//   node quickin-backend/scripts/migrate-stay-notes.mjs
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
-- Free-text the host attaches to a stay (directions, gate code, tips, what to
-- see in the city…). Shown on the QR-linked stay page. Never sensitive.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS host_notes text;
`

const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  console.log('✅ bookings.host_notes added')
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
