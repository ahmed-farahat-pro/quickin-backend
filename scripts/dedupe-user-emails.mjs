// Merge duplicate `users` rows that share an email, then restore uniqueness on
// lower(email) so they cannot come back.
//
// Why this exists: `migrate-split-accounts.mjs` dropped the unique constraint on
// users.email and keyed uniqueness on `(lower(email), role)` to give each address a
// separate guest and host account. That model was abandoned — signup now creates one
// unified account — but the index and the rows created under it are still on Neon, so
// one address can own several rows and "the user with this email" is ambiguous.
//
// The login path already tolerates this (see src/lib/local/login-row-core.ts: the
// password picks the row). This script removes the ambiguity at the source.
//
//   # 1. REPORT ONLY — writes nothing. Always start here.
//   DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require' \
//     node scripts/dedupe-user-emails.mjs
//
//   # 2. Merge duplicates, one transaction per email. Still leaves the index alone.
//   DATABASE_URL=... node scripts/dedupe-user-emails.mjs --apply
//
//   # 3. Only once step 2 reports zero remaining duplicates:
//   DATABASE_URL=... node scripts/dedupe-user-emails.mjs --apply --restore-unique
//
// Referencing tables are discovered from the catalog rather than hardcoded, so a table
// added since this was written is still re-pointed instead of silently orphaned.
// Idempotent: a second run finds nothing to do.
import pg from 'pg'
import { readFileSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')
const RESTORE_UNIQUE = process.argv.includes('--restore-unique')

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}
const cs = dbUrl()
const isLocal = cs.includes('127.0.0.1') || cs.includes('localhost')
const pool = new pg.Pool({ connectionString: cs, ssl: isLocal ? false : { rejectUnauthorized: false } })

/** Every column in the database that references users(id). */
async function referencingColumns() {
  const { rows } = await pool.query(`
    SELECT src.relname AS table_name, att.attname AS column_name
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class tgt ON tgt.oid = c.confrelid
    JOIN unnest(c.conkey) AS k(attnum) ON true
    JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.attnum
    WHERE c.contype = 'f' AND tgt.relname = 'users'
    ORDER BY 1, 2`)
  return rows
}

/**
 * Which row survives a merge.
 *
 * Linked rows come FIRST and by count: the row carrying the bookings, listings and
 * messages is the account the person actually lives in, whatever its `role` says.
 * Ranking on flags first would let an empty-but-verified shell outrank the row holding
 * a year of history — and since the keeper's password is the one that survives, that
 * also silently changes which password works. Only then: verified > active > has a
 * password > oldest. Linked rows are re-pointed, never deleted, either way.
 */
function rankKeeper(a, b) {
  if (a.refs !== b.refs) return b.refs - a.refs
  const score = r =>
    (r.email_verified ? 8 : 0) + (r.account_status === 'active' ? 4 : 0) + (r.password_hash ? 2 : 0)
  const d = score(b) - score(a)
  if (d !== 0) return d
  const ta = a.created_at ? new Date(a.created_at).getTime() : Infinity
  const tb = b.created_at ? new Date(b.created_at).getTime() : Infinity
  return ta - tb || String(a.id).localeCompare(String(b.id))
}

;(async () => {
  const refs = await referencingColumns()
  console.log(`Tables referencing users(id): ${refs.length}`)
  console.log(refs.map(r => `  ${r.table_name}.${r.column_name}`).join('\n') || '  (none)')

  const cols = new Set(
    (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users'`))
      .rows.map(r => r.column_name)
  )
  const opt = (c, fb = 'NULL') => (cols.has(c) ? c : `${fb} AS ${c}`)

  const { rows: dupEmails } = await pool.query(
    `SELECT lower(email) AS email, count(*) AS n FROM users GROUP BY 1 HAVING count(*) > 1 ORDER BY 1`
  )
  console.log(`\nEmails owning more than one row: ${dupEmails.length}`)
  if (dupEmails.length === 0 && !RESTORE_UNIQUE) {
    console.log('Nothing to merge.')
    await pool.end()
    return
  }

  let merged = 0, movedTotal = 0
  for (const { email } of dupEmails) {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, ${opt('role')}, ${opt('email_verified')},
              COALESCE(${cols.has('account_status') ? 'account_status' : `'active'`}, 'active') AS account_status,
              ${opt('created_at')}
       FROM users WHERE lower(email) = $1`,
      [email]
    )
    // How much real data hangs off each row — shown in the report, and a tiebreak.
    for (const r of rows) {
      let n = 0
      for (const { table_name, column_name } of refs) {
        const { rows: [c] } = await pool.query(
          `SELECT count(*)::int AS n FROM "${table_name}" WHERE "${column_name}" = $1`, [r.id]
        )
        n += c.n
      }
      r.refs = n
    }
    const [keeper, ...losers] = [...rows].sort(rankKeeper)
    console.log(`\n${email}`)
    for (const r of rows) {
      console.log(
        `  ${r.id === keeper.id ? 'KEEP  ' : 'merge '}${r.id}  role=${r.role} verified=${r.email_verified} ` +
        `status=${r.account_status} password=${r.password_hash ? 'set' : 'NULL'} linked_rows=${r.refs}`
      )
    }
    // The one thing a merge cannot decide for itself. Both rows may hold a real,
    // working password today (login accepts either — that is the whole point of
    // login-row-core); after the merge only the keeper's does. Nothing in the data
    // says which one the person actually types, so say so plainly rather than
    // quietly locking someone out of their own account.
    const discardedPasswords = losers.filter(
      l => l.password_hash && l.password_hash !== keeper.password_hash
    )
    if (discardedPasswords.length > 0 && keeper.password_hash) {
      console.log(
        `  ⚠️  ${discardedPasswords.length} discarded row(s) hold a DIFFERENT password. Only the ` +
        `keeper's will work after the merge.\n` +
        `      If this person signs in with the other one they will be locked out — have them ` +
        `reset their password, or merge this address by hand.`
      )
    }
    if (!APPLY) continue

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let moved = 0
      for (const loser of losers) {
        for (const { table_name, column_name } of refs) {
          const r = await client.query(
            `UPDATE "${table_name}" SET "${column_name}" = $1 WHERE "${column_name}" = $2`,
            [keeper.id, loser.id]
          )
          moved += r.rowCount
        }
        // Carry over anything the keeper lacks and the loser has, so merging never
        // costs the account a capability it already had.
        if (cols.has('password_hash')) {
          await client.query(
            `UPDATE users SET password_hash = COALESCE(password_hash, $2) WHERE id = $1`,
            [keeper.id, loser.password_hash]
          )
        }
        if (cols.has('email_verified') && loser.email_verified) {
          await client.query(`UPDATE users SET email_verified = true WHERE id = $1`, [keeper.id])
        }
        if (cols.has('is_host')) {
          await client.query(
            `UPDATE users k SET is_host = true FROM users l
             WHERE k.id = $1 AND l.id = $2 AND COALESCE(l.is_host, false)`,
            [keeper.id, loser.id]
          )
        }
        await client.query(`DELETE FROM users WHERE id = $1`, [loser.id])
      }
      await client.query('COMMIT')
      merged++; movedTotal += moved
      console.log(`  -> merged ${losers.length} row(s), re-pointed ${moved} linked row(s)`)
    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`  -> FAILED, rolled back: ${e.message}`)
    } finally {
      client.release()
    }
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to merge.')
    await pool.end()
    return
  }
  console.log(`\nMerged ${merged} email(s); re-pointed ${movedTotal} linked row(s).`)

  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) d`
  )
  console.log(`Emails still owning more than one row: ${left[0].n}`)

  if (RESTORE_UNIQUE) {
    if (left[0].n > 0) {
      console.error('Refusing to restore uniqueness while duplicates remain — resolve them first.')
      await pool.end(); process.exit(1)
    }
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email))`)
    await pool.query(`DROP INDEX IF EXISTS users_email_role_uidx`)
    console.log('✅ unique index on lower(email) restored; users_email_role_uidx dropped')
  } else if (left[0].n === 0) {
    console.log('\nAll clear. Re-run with --apply --restore-unique to key uniqueness on lower(email) again.')
  }
  await pool.end()
})().catch(async e => {
  console.error('dedupe failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
