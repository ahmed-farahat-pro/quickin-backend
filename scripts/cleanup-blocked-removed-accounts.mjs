// Permanently delete all blocked and removed user accounts so those emails
// can be used to sign up again.
//   node quickin-backend/scripts/cleanup-blocked-removed-accounts.mjs
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

async function main() {
  const { rows: victims } = await pool.query(
    `SELECT id, email, full_name, COALESCE(account_status,'active') AS status
       FROM users
      WHERE account_status IN ('blocked','removed')`
  )
  if (victims.length === 0) {
    console.log('No blocked or removed accounts found.')
    await pool.end()
    return
  }
  console.log(`Found ${victims.length} blocked/removed account(s):`)
  for (const v of victims) {
    console.log(`  ${v.email} — ${v.status}`)
  }

  for (const v of victims) {
    await pool.query('BEGIN')
    try {
      await pool.query(`DELETE FROM listings WHERE host_id = $1`, [v.id])
      await pool.query(`DELETE FROM users WHERE id = $1`, [v.id])
      await pool.query('COMMIT')
      console.log(`  deleted ${v.email}`)
    } catch (e) {
      await pool.query('ROLLBACK')
      console.error(`  FAILED ${v.email}:`, e.message)
    }
  }

  console.log('Done.')
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
