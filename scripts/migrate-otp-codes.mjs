// Create the otp_codes table used by the web frontend's OTP verification flow.
//   node quickin-backend/scripts/migrate-otp-codes.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const _cs = dbUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })

const DDL = `
CREATE TABLE IF NOT EXISTS otp_codes (
  email      text PRIMARY KEY,
  code       text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
`

async function main() {
  console.log('Running otp_codes migration...')
  await pool.query(DDL)
  console.log('otp_codes table ready.')
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
