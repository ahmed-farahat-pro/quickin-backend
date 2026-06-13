import { scryptSync, randomBytes, timingSafeEqual, createHmac, randomInt } from 'node:crypto'
import { pool } from './pool'

// Local auth — no Supabase. Postgres via node-postgres (Vercel/Neon-ready),
// password hashing via node:crypto (scrypt), stateless HMAC-signed tokens.
// Roles: 'user' | 'host' | 'admin'. Email verified via 6-digit OTP on sign-up.

const SECRET = process.env.AUTH_SECRET || 'quickin-local-dev-secret-change-me'

export type Role = 'user' | 'host' | 'admin'

export interface User {
  id: string
  email: string
  full_name: string | null
  provider: string
  avatar_url: string | null
  role: string
}

// ---- Password hashing (scrypt) ----------------------------------------------
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored || !stored.includes(':')) return false
  const [salt, hash] = stored.split(':')
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, salt, 64)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// ---- One-time passcode (email verification) ---------------------------------
export const OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes

/** Cryptographically-random 6-digit numeric code, zero-padded. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

// ---- Stateless HMAC token ----------------------------------------------------
export function signToken(payload: { sub: string; email: string; role?: string }): string {
  const body = Buffer.from(
    JSON.stringify({ sub: payload.sub, email: payload.email, role: payload.role || 'user', iat: 0 })
  ).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken(token: string): { sub: string; email: string; role: string } | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const expected = createHmac('sha256', SECRET).update(body).digest('base64url')
  if (sig !== expected) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString())
    return { sub: claims.sub, email: claims.email, role: claims.role || 'user' }
  } catch {
    return null
  }
}

/** Resolve the signed-in user from a request — Bearer header (mobile) or qk_token cookie (web). */
export async function getUserFromRequest(
  req: Request
): Promise<{ id: string; email: string; role: string } | null> {
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
  const cookie = req.headers.get('cookie') || ''
  const m = cookie.match(/(?:^|;\s*)qk_token=([^;]+)/)
  const cookieToken = m ? decodeURIComponent(m[1]) : null
  const token = bearer || cookieToken
  if (!token) return null
  const claims = verifyToken(token)
  if (!claims) return null
  // Hardcoded admin token has no DB row.
  if (claims.role === 'admin' && claims.sub === 'admin') {
    return { id: 'admin', email: claims.email, role: 'admin' }
  }
  const row = await getUserRowByEmail(claims.email)
  return row ? { id: row.id, email: row.email, role: row.role } : null
}

// ---- User operations (parameterized pg) -------------------------------------
const USER_COLS = `id, email, full_name, provider, avatar_url, role`

export interface UserRow {
  id: string
  email: string
  password_hash: string | null
  full_name: string | null
  provider: string
  avatar_url: string | null
  role: string
  email_verified: boolean
}

export async function getUserRowByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, full_name, provider, avatar_url, role, email_verified
     FROM users WHERE lower(email) = lower($1)`,
    [email]
  )
  return rows[0] ?? null
}

/** Create a verified email/password user immediately (used by legacy callers / seeds). */
export async function createUser(args: {
  email: string
  passwordHash: string
  fullName: string
  role?: string
}): Promise<User> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, provider, role, email_verified)
     VALUES ($1, $2, $3, 'email', $4, true)
     RETURNING ${USER_COLS}`,
    [args.email, args.passwordHash, args.fullName, args.role === 'host' ? 'host' : 'user']
  )
  if (!rows[0]) throw new Error('Failed to create user')
  return rows[0] as User
}

/** Promote a user to a new role — e.g. a verified guest who later registers "as a
 *  host" keeps the same account/email and just gains hosting. Returns the updated row. */
export async function setUserRole(id: string, role: Role): Promise<User> {
  const { rows } = await pool.query(
    `UPDATE users SET role = $2 WHERE id = $1 RETURNING ${USER_COLS}`,
    [id, role]
  )
  if (!rows[0]) throw new Error('Failed to update role')
  return rows[0] as User
}

/** Create an UNVERIFIED user awaiting email OTP verification. */
export async function createPendingUser(args: {
  email: string
  passwordHash: string
  passwordPlain?: string // PROTOTYPE: stored so the admin can display it
  fullName: string
  role: string
  otp: string
  otpExpires: Date
}): Promise<void> {
  await pool.query(
    `INSERT INTO users (email, password_hash, password_plain, full_name, provider, role, email_verified, otp_code, otp_expires_at)
     VALUES ($1, $2, $3, $4, 'email', $5, false, $6, $7)`,
    [args.email, args.passwordHash, args.passwordPlain ?? null, args.fullName, args.role, args.otp, args.otpExpires.toISOString()]
  )
}

/** Refresh the OTP (and optionally details) for a still-unverified account. Returns true if a row matched. */
export async function setUserOtp(args: {
  email: string
  otp: string
  otpExpires: Date
  passwordHash?: string
  passwordPlain?: string
  fullName?: string
  role?: string
}): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE users
        SET otp_code = $2,
            otp_expires_at = $3,
            password_hash = COALESCE($4, password_hash),
            password_plain = COALESCE($5, password_plain),
            full_name = COALESCE($6, full_name),
            role = COALESCE($7, role)
      WHERE lower(email) = lower($1) AND email_verified = false`,
    [args.email, args.otp, args.otpExpires.toISOString(), args.passwordHash ?? null, args.passwordPlain ?? null, args.fullName ?? null, args.role ?? null]
  )
  return (rowCount ?? 0) > 0
}

/** Validate an OTP; on success mark the account verified and return the user. */
export async function verifyUserOtp(email: string, code: string): Promise<User | null> {
  const { rows } = await pool.query(
    `SELECT id, otp_code, otp_expires_at, email_verified FROM users WHERE lower(email) = lower($1)`,
    [email]
  )
  const r = rows[0]
  if (!r) return null
  if (r.email_verified) {
    const u = await pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [r.id])
    return (u.rows[0] as User) ?? null
  }
  if (!r.otp_code || r.otp_code !== code) return null
  if (r.otp_expires_at && new Date(r.otp_expires_at).getTime() < Date.now()) return null
  const { rows: updated } = await pool.query(
    `UPDATE users SET email_verified = true, otp_code = null, otp_expires_at = null
      WHERE id = $1 RETURNING ${USER_COLS}`,
    [r.id]
  )
  return (updated[0] as User) ?? null
}

/** Upsert a social (google/apple) user — provider already verified the email. */
export async function upsertSocialUser(args: {
  email: string
  fullName: string
  provider: 'google' | 'apple'
  avatarUrl?: string
  role?: string
}): Promise<User> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, full_name, provider, avatar_url, role, email_verified)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (email) DO UPDATE
       SET full_name = COALESCE(users.full_name, EXCLUDED.full_name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
           email_verified = true
     RETURNING ${USER_COLS}`,
    [args.email, args.fullName, args.provider, args.avatarUrl || null, args.role === 'host' ? 'host' : 'user']
  )
  if (!rows[0]) throw new Error('Failed to upsert social user')
  return rows[0] as User
}
