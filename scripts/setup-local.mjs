// One-command local database setup for QuickIn.
//
// Builds a COMPLETE local schema — base tables + every incremental migration +
// the staff RBAC tables — then optionally seeds a super admin for /ops.
// Everything is idempotent, so re-running is safe and is the way to pick up new
// migrations later.
//
//   createdb quickin_local
//   DATABASE_URL=postgresql://localhost:5432/quickin_local node scripts/setup-local.mjs
//
// With a super admin in one go:
//   DATABASE_URL=... SUPERADMIN_EMAIL=you@quickin.app SUPERADMIN_PASSWORD='LocalDev12345' \
//     node scripts/setup-local.mjs
//
// Why this exists: init.sql alone is NOT a working schema — 20+ later migrations add
// columns the app reads (users.is_host, bookings.paid_at, the reports table, …), so a
// DB built from init.sql only will 500 on several admin endpoints.
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const m = env.match(/^DATABASE_URL=(.*)$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* no .env */ }
  throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
}

const url = databaseUrl()
const isLocal = url.includes('127.0.0.1') || url.includes('localhost')

// Guard: this seeds demo data and is meant for a scratch DB. Refuse to point it at
// anything that isn't obviously local unless explicitly forced.
if (!isLocal && process.env.ALLOW_REMOTE !== '1') {
  console.error(
    `❌ ${url.replace(/:[^:@/]*@/, ':***@')} does not look local.\n` +
    `   setup-local.mjs seeds demo data — do not point it at Neon prod.\n` +
    `   Set ALLOW_REMOTE=1 only if you are certain.`
  )
  process.exit(1)
}

// Base schema first (creates the tables every ALTER below depends on), then each
// migration. Order follows how they were built; a second pass catches any that
// depend on a table created by a later one.
const MIGRATIONS = [
  'migrate-country.mjs',
  'migrate-extras.mjs',
  'migrate-profile-bio.mjs',
  'migrate-pending-role.mjs',
  'migrate-password-plain.mjs',
  'migrate-split-accounts.mjs',
  'migrate-trust.mjs',
  'migrate-growth.mjs',
  'migrate-regions.mjs',
  'migrate-availability.mjs',
  'migrate-seasonal-pricing.mjs',
  'migrate-cancellation.mjs',
  'migrate-listing-approval.mjs',
  'migrate-stay-notes.mjs',
  'migrate-services.mjs',
  'migrate-wishlist-reviews.mjs',
  'migrate-reviews-twoway.mjs',
  'migrate-notifications.mjs',
  'migrate-payments.mjs',
  'migrate-instapay.mjs',
  // Schema the web app owns; it never had a script until now (it was applied to Neon
  // via the deleted xmig4/5/6 routes), so a fresh DB is unusable without it.
  'migrate-web-tables.mjs',
  'migrate-staff-rbac.mjs',
  // Resorts must precede analytics only for readability; they are independent.
  'migrate-resorts.mjs',
  'migrate-analytics.mjs',
  'migrate-account-status.mjs',
  'migrate-documents-audit.mjs',
  'migrate-activity.mjs',
  'migrate-guest-breakdown.mjs',
  'migrate-policy-violations.mjs',
  'migrate-disputes.mjs',
  'migrate-payout-methods.mjs',
  'migrate-id-change-requests.mjs',
]

const pool = new pg.Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } })

function runScript(name) {
  execFileSync(process.execPath, [path.join(HERE, name)], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  })
}

;(async () => {
  console.log(`→ ${url.replace(/:[^:@/]*@/, ':***@')}\n`)

  // ---- 1. base schema -------------------------------------------------------
  process.stdout.write('  init.sql … ')
  const initSql = readFileSync(path.join(HERE, '../local-backend/init.sql'), 'utf8')
  await pool.query(initSql)
  console.log('ok')

  // ---- 2. migrations --------------------------------------------------------
  const failed = []
  for (const name of MIGRATIONS) {
    process.stdout.write(`  ${name.replace(/^migrate-|\.mjs$/g, '').padEnd(20)} … `)
    try {
      runScript(name)
      console.log('ok')
    } catch (e) {
      console.log('deferred')
      failed.push([name, e])
    }
  }

  // Second pass: a migration that failed only because of ordering will now succeed.
  const stillFailed = []
  if (failed.length) {
    console.log('\n  retrying deferred migrations…')
    for (const [name, firstErr] of failed) {
      process.stdout.write(`  ${name.replace(/^migrate-|\.mjs$/g, '').padEnd(20)} … `)
      try {
        runScript(name)
        console.log('ok')
      } catch {
        console.log('FAILED')
        stillFailed.push([name, firstErr])
      }
    }
  }

  // ---- 3. optional super admin ---------------------------------------------
  if (process.env.SUPERADMIN_EMAIL && process.env.SUPERADMIN_PASSWORD) {
    process.stdout.write('\n  super admin          … ')
    try {
      runScript('seed-superadmin.mjs')
      console.log(`ok (${process.env.SUPERADMIN_EMAIL})`)
    } catch (e) {
      const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '')
      console.log(out.includes('already exists') ? 'skipped — one already exists' : 'FAILED')
      if (!out.includes('already exists')) console.error(out.trim())
    }
  }

  // ---- 4. report ------------------------------------------------------------
  const t = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`
  )
  const staff = await pool.query(
    `SELECT count(*)::int AS n FROM staff_accounts WHERE role='super_admin' AND is_active`
  )
  const listings = await pool.query(`SELECT count(*)::int AS n FROM listings`)

  console.log(`\n${stillFailed.length ? '⚠️ ' : '✅'} local DB ready — ${t.rows[0].n} tables, ` +
              `${listings.rows[0].n} demo listings, ${staff.rows[0].n} active super admin`)

  if (stillFailed.length) {
    console.log('\n  these did not apply:')
    for (const [name, err] of stillFailed) {
      // Surface the first meaningful line, not the trailing "Node.js v22" banner.
      const out = ((err.stderr?.toString() || '') + (err.stdout?.toString() || '')).trim()
      const line = out.split('\n').find((l) => /error|failed/i.test(l)) || out.split('\n')[0] || err.message
      console.log(`    ${name}: ${line.trim()}`)
    }
  }
  if (staff.rows[0].n === 0) {
    console.log('\n  no super admin yet — sign-in at /ops/login needs one:')
    console.log('    SUPERADMIN_EMAIL=you@quickin.app SUPERADMIN_PASSWORD=\'LocalDev12345\' \\')
    console.log('      node scripts/seed-superadmin.mjs')
  } else {
    console.log('\n  next: npm run dev  (then open http://localhost:3000/ops/login)')
  }
  await pool.end()
})().catch(async (e) => {
  console.error('\nSETUP FAILED:', e.message || e)
  try { await pool.end() } catch {}
  process.exit(1)
})
