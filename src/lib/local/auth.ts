import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'
import { pool } from './pool'

// Local auth — no Supabase. Postgres via node-postgres (Vercel/Neon-ready),
// password hashing via node:crypto (scrypt), stateless HMAC-signed tokens.

const SECRET = process.env.AUTH_SECRET || 'quickin-local-dev-secret-change-me'

export interface User {
  id: string
  email: string
  full_name: string | null
  provider: string
  avatar_url: string | null
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

// ---- Stateless HMAC token ----------------------------------------------------
export function signToken(payload: { sub: string; email: string }): string {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: 0 })).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken(token: string): { sub: string; email: string } | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const expected = createHmac('sha256', SECRET).update(body).digest('base64url')
  if (sig !== expected) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    return null
  }
}

/** Resolve the signed-in user from a request — Bearer header (mobile) or qk_token cookie (web). */
export async function getUserFromRequest(
  req: Request
): Promise<{ id: string; email: string } | null> {
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
  const cookie = req.headers.get('cookie') || ''
  const m = cookie.match(/(?:^|;\s*)qk_token=([^;]+)/)
  const cookieToken = m ? decodeURIComponent(m[1]) : null
  const token = bearer || cookieToken
  if (!token) return null
  const claims = verifyToken(token)
  if (!claims) return null
  const row = await getUserRowByEmail(claims.email)
  return row ? { id: row.id, email: row.email } : null
}

// ---- User operations (parameterized pg) -------------------------------------
const USER_COLS = `id, email, full_name, provider, avatar_url`

export async function getUserRowByEmail(
  email: string
): Promise<{ id: string; email: string; password_hash: string | null; full_name: string | null; provider: string; avatar_url: string | null } | null> {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, full_name, provider, avatar_url
     FROM users WHERE lower(email) = lower($1)`,
    [email]
  )
  return rows[0] ?? null
}

export async function createUser(args: {
  email: string
  passwordHash: string
  fullName: string
}): Promise<User> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, provider)
     VALUES ($1, $2, $3, 'email')
     RETURNING ${USER_COLS}`,
    [args.email, args.passwordHash, args.fullName]
  )
  if (!rows[0]) throw new Error('Failed to create user')
  return rows[0] as User
}

/** Upsert a social (google/apple) user. */
export async function upsertSocialUser(args: {
  email: string
  fullName: string
  provider: 'google' | 'apple'
  avatarUrl?: string
}): Promise<User> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, full_name, provider, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET full_name = COALESCE(users.full_name, EXCLUDED.full_name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url)
     RETURNING ${USER_COLS}`,
    [args.email, args.fullName, args.provider, args.avatarUrl || null]
  )
  if (!rows[0]) throw new Error('Failed to upsert social user')
  return rows[0] as User
}
