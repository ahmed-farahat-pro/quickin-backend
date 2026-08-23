// Staff RBAC — the super admin + moderators who use the /ops admin panel.
//
// Deliberately separate from src/lib/local/auth.ts (guests/hosts): staff live in
// their own `staff_accounts` table, sign in at /ops/login, and carry their own
// `qk_staff` cookie signed with its own secret. A guest token can never satisfy a
// staff gate and vice versa.
//
// Modelled on HubDrives' SectionAccessHandler: one choke point (`requireStaff`)
// applied to every admin route, super admin passes everything, a moderator must
// hold the module. Two improvements over that reference, both required here:
// sessions are DB rows so they can be REVOKED (deactivating a moderator kills their
// live login immediately), and failed logins are counted per-account.
//
// This file owns auth/session/permission SQL, the same way auth.ts owns user/OTP
// SQL. The staff *management* CRUD (list/create/update/permissions) lives in db.ts
// alongside the other admin helpers.
//
// IMPORTANT: a near-identical copy of this file exists in
// quickin-frontend/src/lib/local/staff.ts — the two repos share one Neon DB
// but cannot import each other (db.ts is already duplicated the same way). Only the
// legacy-compat import differs (this repo's getUserFromRequest already returns the
// role). scripts/check-staff-parity.mjs fails if STAFF_MODULES drifts.
import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from './pool'
import { hashPassword, verifyPassword, getUserFromRequest } from './auth'

const SECRET = process.env.STAFF_AUTH_SECRET || process.env.AUTH_SECRET || 'quickin-local-dev-secret-change-me'

/** Absolute session lifetime. A staff login is good for 8h no matter how active. */
export const STAFF_SESSION_TTL_MS = 8 * 60 * 60 * 1000
/** Idle window — no admin request for this long and the session is dead (A5 auto-logout). */
export const STAFF_IDLE_MS = Number(process.env.STAFF_IDLE_MINUTES || 30) * 60 * 1000
/** How often last_seen_at is actually written. The Neon DB is shared; unthrottled,
 *  every admin request would become a write. */
const TOUCH_THROTTLE_MS = 2 * 60 * 1000
/** Consecutive failed logins before the account locks, and for how long. */
export const MAX_LOGIN_ATTEMPTS = 5
export const LOCKOUT_MS = 15 * 60 * 1000
/** Reset-code policy — the HubDrives PasswordResetRequest contract. */
export const RESET_TTL_MS = 15 * 60 * 1000
export const MAX_RESET_ATTEMPTS = 5

export const STAFF_COOKIE = 'qk_staff'

// ---- The module catalog -----------------------------------------------------
// Kept in code rather than a DB table (HubDrives uses AdminSection rows): a module
// only exists if there is a /ops surface and a route to gate, so a row for a module
// with no code would be meaningless — and with the frontend and backend deploying
// separately, each would still need its own hardcoded route→module map.
//
// `key` doubles as the /ops tab id, so page.tsx needs no mapping table.
// KEEP IN SYNC with backend/quickin-backend/src/lib/local/staff.ts.
export const STAFF_MODULES = [
  { key: 'overview', label: 'Overview', description: 'Dashboard totals and revenue' },
  { key: 'users', label: 'Users', description: 'Guest and host accounts' },
  { key: 'listings', label: 'Listings', description: 'Properties, publish and delete' },
  { key: 'bookings', label: 'Bookings', description: 'Reservations and their status' },
  { key: 'applications', label: 'Host applications', description: 'Approve or reject new hosts' },
  { key: 'verifications', label: 'ID verifications', description: 'Review submitted ID documents' },
  // Separate from `verifications` so ID-number corrections can be delegated without
  // also handing over the decision that verifies an account and gates its listings.
  // Its surface lives on the /ops verifications screen, which is why that page admits
  // either module.
  { key: 'id_changes', label: 'ID change requests', description: 'Approve or reject changes to a user\'s ID number' },
  { key: 'documents', label: 'Documents', description: 'Open ID and ownership documents' },
  { key: 'payments', label: 'Payments & disputes', description: 'Transfer proofs, disputes, destinations' },
  { key: 'promos', label: 'Promo codes', description: 'Discount codes and limits' },
  { key: 'reports', label: 'Reports', description: 'User-filed abuse reports' },
  { key: 'moderation', label: 'Moderation', description: 'Users caught sharing contact details, warnings and suspensions' },
  { key: 'disputes', label: 'Guest disputes', description: 'Issues guests raise about a stay — investigate and resolve' },
  { key: 'notify', label: 'Broadcasts', description: 'Send push and email to segments' },
  { key: 'analytics', label: 'Analytics', description: 'Booking, revenue and cancellation reports' },
  { key: 'resorts', label: 'Resorts', description: 'Compound catalog and pending submissions' },
  { key: 'pricing', label: 'Pricing & commission', description: 'The platform commission added to every listing price' },
  { key: 'audit', label: 'Audit log', description: 'Read the record of every staff action', superAdminOnly: true },
  { key: 'staff', label: 'Staff & permissions', description: 'Manage moderators', superAdminOnly: true },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  description: string
  superAdminOnly?: boolean
}>

export type StaffModule = (typeof STAFF_MODULES)[number]['key']
export type StaffRole = 'super_admin' | 'moderator'

const MODULE_KEYS = new Set<string>(STAFF_MODULES.map((m) => m.key))
const SUPER_ADMIN_ONLY = new Set<string>(
  STAFF_MODULES.filter((m) => 'superAdminOnly' in m && m.superAdminOnly).map((m) => m.key)
)

/** Modules a moderator may actually be granted (i.e. excluding super-admin-only ones). */
export const GRANTABLE_MODULES = STAFF_MODULES.filter((m) => !SUPER_ADMIN_ONLY.has(m.key))

/** Keeps unknown/super-admin-only keys out of staff_permissions. */
export function normalizeModules(input: unknown): StaffModule[] {
  if (!Array.isArray(input)) return []
  const out = new Set<string>()
  for (const raw of input) {
    const key = String(raw ?? '').trim().toLowerCase()
    if (MODULE_KEYS.has(key) && !SUPER_ADMIN_ONLY.has(key)) out.add(key)
  }
  return [...out] as StaffModule[]
}

export interface StaffSession {
  staffId: string
  sid: string
  email: string
  fullName: string
  role: StaffRole
  modules: StaffModule[]
  /** True when this identity came from the legacy users.role='admin' compat path
   *  rather than a real staff session. Temporary — see STAFF_ALLOW_LEGACY_ADMIN. */
  legacy?: boolean
}

// ---- Passwords ---------------------------------------------------------------
// Reuses the scrypt pair from auth.ts, so staff hashes are the same 'salt:hash'
// format as users.password_hash. There is no plaintext column for staff, ever.
export { hashPassword as hashStaffPassword, verifyPassword as verifyStaffPassword }

/** Returns null when acceptable, else a human-readable reason.
 *  Stricter than the users' 6-char rule. Mirrored in scripts/seed-superadmin.mjs. */
export function validateStaffPassword(password: string, email: string): string | null {
  const pw = String(password ?? '')
  if (pw.length < 10) return 'Password must be at least 10 characters'
  if (!/[a-zA-Z]/.test(pw)) return 'Password must contain a letter'
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit'
  const local = String(email ?? '').split('@')[0]
  if (local && pw.toLowerCase() === local.toLowerCase()) return 'Password must not be your email name'
  return null
}

/** A cryptographically-random 6-digit reset code, zero-padded. */
export function generateResetCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

// ---- Token ------------------------------------------------------------------
// Same 2-part base64url(JSON).HMAC shape as auth.ts's signToken, plus a `typ`
// discriminator and its own secret — so a staff token is not interchangeable with a
// guest qk_token even if both secrets happen to be the AUTH_SECRET default.
type StaffClaims = { typ: 'staff'; sid: string; sub: string; email: string; role: StaffRole; iat: number; exp: number }

export function signStaffToken(c: { sid: string; sub: string; email: string; role: StaffRole }): string {
  const now = Date.now()
  const body = Buffer.from(
    JSON.stringify({ typ: 'staff', sid: c.sid, sub: c.sub, email: c.email, role: c.role, iat: now, exp: now + STAFF_SESSION_TTL_MS })
  ).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyStaffToken(token: string): StaffClaims | null {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const expected = createHmac('sha256', SECRET).update(body).digest('base64url')
  if (sig !== expected) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as StaffClaims
    if (claims.typ !== 'staff') return null
    if (typeof claims.exp !== 'number' || Date.now() > claims.exp) return null
    if (!claims.sid || !claims.sub) return null
    return claims
  } catch {
    return null
  }
}

function tokenFromRequest(req: Request): string | null {
  const auth = req.headers.get('authorization') || ''
  if (auth.toLowerCase().startsWith('bearer ')) {
    const bearer = auth.slice(7).trim()
    // Only treat it as a staff token if it actually is one — otherwise a guest's
    // Bearer token would shadow their qk_staff cookie and lock them out of /ops.
    if (bearer && verifyStaffToken(bearer)) return bearer
  }
  const cookie = req.headers.get('cookie') || ''
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${STAFF_COOKIE}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : null
}

// ---- Session resolution -----------------------------------------------------

type SessionRow = {
  sid: string
  expires_at: string
  last_seen_at: string
  revoked_at: string | null
  staff_id: string
  email: string
  full_name: string
  role: string
  is_active: boolean
  modules: string[]
}

/**
 * Resolve the signed-in staff member, or null. Validates, in order: token
 * signature and expiry, that the session row exists and is neither revoked nor
 * expired, that it is inside the idle window, and that the account is still
 * active. Permissions are re-read from the DB on every call, so a permission
 * change lands on the moderator's next request without logging them out.
 *
 * Takes a raw token so it can serve both API routes (via getStaffFromRequest) and
 * server components, which have `cookies()` rather than a Request.
 */
export async function resolveStaffSession(token: string | null | undefined): Promise<StaffSession | null> {
  if (!token) return null
  const claims = verifyStaffToken(token)
  if (!claims) return null

  let row: SessionRow | undefined
  try {
    const { rows } = await pool.query<SessionRow>(
      `SELECT s.id AS sid, s.expires_at, s.last_seen_at, s.revoked_at,
              a.id AS staff_id, a.email, a.full_name, a.role, a.is_active,
              COALESCE(array_agg(p.module) FILTER (WHERE p.module IS NOT NULL), '{}') AS modules
         FROM staff_sessions s
         JOIN staff_accounts a ON a.id = s.staff_id
         LEFT JOIN staff_permissions p ON p.staff_id = a.id
        WHERE s.id = $1
        GROUP BY s.id, a.id`,
      [claims.sid]
    )
    row = rows[0]
  } catch {
    // staff tables not migrated yet — behave as "not signed in" rather than 500.
    return null
  }
  if (!row) return null
  if (row.revoked_at) return null
  if (!row.is_active) return null
  if (Date.parse(row.expires_at) <= Date.now()) return null
  if (Date.now() - Date.parse(row.last_seen_at) > STAFF_IDLE_MS) return null

  // Throttled activity ping — the authority for the idle timeout.
  if (Date.now() - Date.parse(row.last_seen_at) > TOUCH_THROTTLE_MS) {
    try {
      await pool.query(`UPDATE staff_sessions SET last_seen_at = now() WHERE id = $1`, [row.sid])
    } catch { /* best-effort */ }
  }

  return {
    staffId: row.staff_id,
    sid: row.sid,
    email: row.email,
    fullName: row.full_name,
    role: row.role === 'super_admin' ? 'super_admin' : 'moderator',
    modules: (row.modules || []).filter((m) => MODULE_KEYS.has(m)) as StaffModule[],
  }
}

/** Resolve the signed-in staff member from an API request (cookie or Bearer). */
export async function getStaffFromRequest(req: Request): Promise<StaffSession | null> {
  return resolveStaffSession(tokenFromRequest(req))
}

/** Create a session row and return the signed token for it. */
export async function createStaffSession(
  staff: { id: string; email: string; role: StaffRole },
  req: Request
): Promise<{ token: string; sid: string; expiresAt: Date }> {
  const sid = randomUUID()
  const expiresAt = new Date(Date.now() + STAFF_SESSION_TTL_MS)
  await pool.query(
    `INSERT INTO staff_sessions (id, staff_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [sid, staff.id, expiresAt.toISOString(), clientIpOf(req), (req.headers.get('user-agent') || '').slice(0, 300)]
  )
  return { token: signStaffToken({ sid, sub: staff.id, email: staff.email, role: staff.role }), sid, expiresAt }
}

/** Kill live logins. Called on deactivate, password change and force-logout —
 *  the gap left open in HubDrives, where a deactivated moderator's JWT kept working. */
export async function revokeStaffSessions(staffId: string, exceptSid?: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE staff_sessions SET revoked_at = now()
      WHERE staff_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [staffId, exceptSid ?? null]
  )
  return rowCount ?? 0
}

export async function revokeStaffSession(sid: string): Promise<void> {
  await pool.query(`UPDATE staff_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sid])
}

/** Cookie options for the staff session cookie. */
export function staffCookieOptions(maxAgeSeconds = STAFF_SESSION_TTL_MS / 1000) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}

// ---- Permission checks ------------------------------------------------------

/**
 * The single choke point, equivalent to HubDrives' SectionAccessHandler:
 * a super admin passes everything; a moderator must hold the module and can never
 * hold a super-admin-only one, however staff_permissions was written.
 */
export function staffCan(staff: StaffSession, module: StaffModule): boolean {
  if (staff.role === 'super_admin') return true
  if (SUPER_ADMIN_ONLY.has(module)) return false
  return staff.modules.includes(module)
}

type Gate = { staff: StaffSession } | { error: NextResponse }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

// Preserved verbatim from the routes this replaces, so clients see no change.
const notSignedIn = () => NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
const forbidden = () => NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })

/**
 * Route gate. Use at the top of every admin handler:
 *
 *   const gate = await requireStaff(req, 'bookings')
 *   if ('error' in gate) return gate.error
 *   // …gate.staff
 */
export async function requireStaff(req: Request, module: StaffModule): Promise<Gate> {
  const staff = await getStaffFromRequest(req)
  if (staff) return staffCan(staff, module) ? { staff } : { error: forbidden() }

  const legacy = await legacyAdmin(req)
  if (legacy) return { staff: legacy }
  return { error: notSignedIn() }
}

/** For the staff-management routes themselves — never satisfiable by a moderator. */
export async function requireSuperAdmin(req: Request): Promise<Gate> {
  const staff = await getStaffFromRequest(req)
  if (staff) return staff.role === 'super_admin' ? { staff } : { error: forbidden() }

  const legacy = await legacyAdmin(req)
  if (legacy) return { staff: legacy }
  return { error: notSignedIn() }
}

// ---- Legacy compatibility (temporary) ---------------------------------------
// During the cutover the old operator — a `users` row with role='admin' — keeps
// working, so the frontend and backend can deploy independently without locking
// anyone out. Every use is recorded; once staff_audit_log shows no 'legacy_fallback'
// rows, set STAFF_ALLOW_LEGACY_ADMIN=0 and then delete this block.
// NOTE: the shared ADMIN_OPS_KEY is deliberately NOT part of this fallback.
async function legacyAdmin(req: Request): Promise<StaffSession | null> {
  if (process.env.STAFF_ALLOW_LEGACY_ADMIN !== '1') return null
  const user = await getUserFromRequest(req)
  if (!user || user.role !== 'admin') return null
  const session: StaffSession = {
    staffId: user.id,
    sid: 'legacy',
    email: user.email,
    fullName: user.email,
    role: 'super_admin',
    modules: STAFF_MODULES.map((m) => m.key) as StaffModule[],
    legacy: true,
  }
  await logStaffAction({
    staffId: null,
    staffEmail: user.email,
    action: 'legacy_fallback',
    detail: { path: new URL(req.url).pathname, users_id: user.id },
    ip: clientIpOf(req),
  })
  return session
}

// ---- Audit ------------------------------------------------------------------

/** Best-effort admin action trail. Never throws — an audit failure must not break
 *  the action being audited. `staffId` may be null for pre-auth events (failed logins). */
export async function logStaffAction(entry: {
  staffId: string | null
  staffEmail: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  detail?: unknown
  ip?: string | null
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO staff_audit_log (staff_id, staff_email, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        entry.staffId,
        entry.staffEmail,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        entry.ip ?? null,
      ]
    )
  } catch { /* best-effort */ }
}

/** Best-effort client IP from proxy headers. Mirrors clientIp() in auth.ts; kept
 *  local so this module stands alone in both repos. */
export function clientIpOf(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return req.headers.get('x-real-ip') || 'local'
}

/** Actor string for the TEXT audit columns that already hold `users.id` values
 *  (app_settings.updated_by, payment_proofs.reviewed_by) — prefixed so rows written
 *  before and after the staff cutover stay distinguishable. */
export function staffActor(staff: StaffSession): string {
  return staff.legacy ? staff.staffId : `staff:${staff.staffId}`
}
