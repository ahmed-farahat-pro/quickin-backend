import { NextResponse } from 'next/server'
import { getStaffByEmail, noteStaffLoginFailure, noteStaffLoginSuccess } from '@/lib/local/db'
import { rateLimit } from '@/lib/local/auth'
import {
  createStaffSession,
  logStaffAction,
  clientIpOf,
  verifyStaffPassword,
  staffCookieOptions,
  STAFF_COOKIE,
  MAX_LOGIN_ATTEMPTS,
  LOCKOUT_MS,
} from '@/lib/local/staff'

// Admin-panel sign-in (A1, A5).
//   POST /api/local/staff/login { email, password } → { staff } + qk_staff cookie
//
// Unlike the rest of /api/local/*, the staff routes are NOT CORS-open: they are
// same-origin browser calls carrying a session cookie, so a wildcard
// Access-Control-Allow-Origin would be pointless at best. Only no-store is set.
//
// A5 brute-force protection is two-layered: a per-account counter in
// staff_accounts (survives cold starts, blocks password spraying against one
// account) plus the in-memory per-IP limiter as a cheap per-instance brake.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

/** Deliberately identical for unknown email and wrong password. */
const INVALID = 'Invalid email or password'

export async function POST(req: Request) {
  const ip = clientIpOf(req)
  try {
    const wait = rateLimit(`staff-login:${ip}`, 20, 5 * 60_000)
    if (wait) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${wait}s.` },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(wait) } }
      )
    }

    const body = await req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim()
    const password = String(body.password ?? '')
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers: NO_STORE })
    }

    const staff = await getStaffByEmail(email)
    if (!staff) {
      // No row to count against, so only the IP limiter applies here.
      await logStaffAction({ staffId: null, staffEmail: email, action: 'login_failed', detail: { reason: 'no_such_account' }, ip })
      return NextResponse.json({ error: INVALID }, { status: 401, headers: NO_STORE })
    }

    // Lockout is checked before the password so a locked account can't be probed.
    if (staff.locked_until && Date.parse(staff.locked_until) > Date.now()) {
      const secs = Math.ceil((Date.parse(staff.locked_until) - Date.now()) / 1000)
      await logStaffAction({ staffId: staff.id, staffEmail: staff.email, action: 'login_blocked', detail: { locked_for_s: secs }, ip })
      return NextResponse.json(
        { error: `Too many failed attempts. This account is locked for ${Math.ceil(secs / 60)} more minute(s).`, locked: true },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(secs) } }
      )
    }

    if (!verifyStaffPassword(password, staff.password_hash)) {
      const after = await noteStaffLoginFailure(staff.id, MAX_LOGIN_ATTEMPTS, LOCKOUT_MS)
      const nowLocked = Boolean(after.lockedUntil && Date.parse(after.lockedUntil) > Date.now())
      await logStaffAction({
        staffId: staff.id,
        staffEmail: staff.email,
        action: nowLocked ? 'login_locked' : 'login_failed',
        detail: { attempts: after.attempts, reason: 'bad_password' },
        ip,
      })
      if (nowLocked) {
        return NextResponse.json(
          { error: `Too many failed attempts. This account is locked for ${Math.round(LOCKOUT_MS / 60000)} minutes.`, locked: true },
          { status: 429, headers: { ...NO_STORE, 'Retry-After': String(Math.round(LOCKOUT_MS / 1000)) } }
        )
      }
      const left = Math.max(0, MAX_LOGIN_ATTEMPTS - after.attempts)
      return NextResponse.json(
        { error: INVALID, attempts_left: left },
        { status: 401, headers: NO_STORE }
      )
    }

    // Password is correct — only now is it safe to reveal the account's state.
    if (!staff.is_active) {
      await logStaffAction({ staffId: staff.id, staffEmail: staff.email, action: 'login_deactivated', ip })
      return NextResponse.json(
        { error: 'This account has been deactivated. Contact the super admin.' },
        { status: 403, headers: NO_STORE }
      )
    }

    await noteStaffLoginSuccess(staff.id)
    const { token, sid, expiresAt } = await createStaffSession(
      { id: staff.id, email: staff.email, role: staff.role },
      req
    )
    await logStaffAction({ staffId: staff.id, staffEmail: staff.email, action: 'login', detail: { sid }, ip })

    const res = NextResponse.json(
      {
        staff: {
          id: staff.id,
          email: staff.email,
          full_name: staff.full_name,
          role: staff.role,
        },
        expires_at: expiresAt.toISOString(),
      },
      { headers: NO_STORE }
    )
    res.cookies.set(STAFF_COOKIE, token, staffCookieOptions())
    return res
  } catch (err) {
    console.error('staff login failed:', err)
    return NextResponse.json({ error: 'Sign-in failed', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}
