// Creates the FIRST super admin for the /ops admin panel (A1).
//
// This is a bootstrap, not a backdoor: it refuses to run once an active super admin
// exists, so it cannot be used to mint a second one or to re-take the panel later.
// After this, every further account is created from /ops/staff by the super admin.
//
//   SUPERADMIN_EMAIL=you@quickin.app SUPERADMIN_PASSWORD='…' \
//     node quickin-backend/scripts/seed-superadmin.mjs
//
// Run migrate-staff-rbac.mjs first. On prod (Vercel has no shell) use the key-gated
// /api/local/xmig7 route in quickin-frontend instead.
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { randomBytes, scryptSync } from 'node:crypto'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

// Same format as users.password_hash and src/lib/local/staff.ts: 'saltHex:hashHex',
// 16-byte salt, 64-byte scrypt key at Node defaults.
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

// Mirrors validateStaffPassword() in src/lib/local/staff.ts — keep the two in step.
function validatePassword(pw, email) {
  if (pw.length < 10) return 'Password must be at least 10 characters'
  if (!/[a-zA-Z]/.test(pw)) return 'Password must contain a letter'
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit'
  const local = email.split('@')[0]
  if (local && pw.toLowerCase() === local.toLowerCase()) return 'Password must not be your email name'
  return null
}

const email = (process.env.SUPERADMIN_EMAIL || process.argv[2] || '').trim().toLowerCase()
const password = process.env.SUPERADMIN_PASSWORD || process.argv[3] || ''
const fullName = (process.env.SUPERADMIN_NAME || 'Super Admin').trim()

// TLS for managed Postgres (Neon); off for a local instance, which doesn't offer it.
const url = databaseUrl()
const isLocal = url.includes('127.0.0.1') || url.includes('localhost')
const pool = new pg.Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  if (!email || !password) {
    throw new Error('SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD are required')
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`not a valid email: ${email}`)
  }
  const bad = validatePassword(password, email)
  if (bad) throw new Error(bad)

  if (!(await pool.query(`SELECT to_regclass('public.staff_accounts') AS t`)).rows[0].t) {
    throw new Error('staff_accounts does not exist — run scripts/migrate-staff-rbac.mjs first')
  }

  // The guard that keeps this a bootstrap rather than a standing backdoor.
  const existing = await pool.query(
    `SELECT email FROM staff_accounts WHERE role = 'super_admin' AND is_active ORDER BY created_at LIMIT 5`
  )
  if (existing.rows.length > 0) {
    console.error(
      `❌ refused — an active super admin already exists (${existing.rows.map((r) => r.email).join(', ')}).\n` +
      `   Create further accounts from /ops/staff. To recover a lost password, use\n` +
      `   "Forgot password" on /ops/login, or reset password_hash directly in SQL.`
    )
    await pool.end()
    process.exit(1)
  }

  const { rows } = await pool.query(
    `INSERT INTO staff_accounts (email, password_hash, full_name, role, is_active)
     VALUES (lower($1), $2, $3, 'super_admin', true)
     ON CONFLICT (lower(email)) DO UPDATE
       SET password_hash       = EXCLUDED.password_hash,
           full_name           = EXCLUDED.full_name,
           role                = 'super_admin',
           is_active           = true,
           failed_login_attempts = 0,
           locked_until        = NULL,
           password_changed_at = now(),
           updated_at          = now()
     RETURNING id, email, role, created_at`,
    [email, hashPassword(password), fullName]
  )
  const row = rows[0]

  await pool.query(
    `INSERT INTO staff_audit_log (staff_id, staff_email, action, detail)
     VALUES ($1, $2, 'seed_super_admin', $3::jsonb)`,
    [row.id, row.email, JSON.stringify({ via: 'scripts/seed-superadmin.mjs' })]
  )

  console.log(`✅ super admin ready — ${row.email} (${row.id})`)
  console.log(`   sign in at /ops/login`)
  await pool.end()
})().catch(async (e) => { console.error('SEED FAILED:', e.message || e); try { await pool.end() } catch {}; process.exit(1) })
