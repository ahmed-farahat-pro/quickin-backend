// Clear ages outside MIN_AGE..MAX_AGE from `users.age`.
//
// The column is an integer and `PATCH /api/local/profile` reached it through
// `Number()`, so `01012345678` was storable as the age 1012345678 — a phone
// number on a profile, through the one field on Edit profile the content guard
// cannot read (see README → *An age is a number, not a channel*). The route
// refuses those now, but a value written before it did is still on the row and
// still rendered, so closing the door means clearing what came through it.
//
//   node quickin-backend/scripts/cleanup-implausible-ages.mjs          # dry run
//   node quickin-backend/scripts/cleanup-implausible-ages.mjs --apply  # writes
//
// Idempotent: a second run finds nothing. Sets the column to NULL rather than to
// a guess — the age is optional, and inventing one would be worse than none.
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { MIN_AGE, MAX_AGE } from '../src/lib/local/profile-core.ts'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const _cs = dbUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })

const APPLY = process.argv.includes('--apply')

async function main() {
  const { rows } = await pool.query(
    `SELECT id, email, age FROM users
      WHERE age IS NOT NULL AND (age < $1 OR age > $2)
      ORDER BY age DESC`,
    [MIN_AGE, MAX_AGE]
  )
  if (rows.length === 0) {
    console.log(`No age outside ${MIN_AGE}–${MAX_AGE} found. Nothing to do.`)
    await pool.end()
    return
  }
  console.log(`Found ${rows.length} row(s) with an age outside ${MIN_AGE}–${MAX_AGE}:`)
  for (const r of rows) console.log(`  ${r.email} — ${r.age}`)

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to clear them.')
    await pool.end()
    return
  }
  const { rowCount } = await pool.query(
    `UPDATE users SET age = NULL WHERE age IS NOT NULL AND (age < $1 OR age > $2)`,
    [MIN_AGE, MAX_AGE]
  )
  console.log(`\nCleared ${rowCount} age(s).`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
