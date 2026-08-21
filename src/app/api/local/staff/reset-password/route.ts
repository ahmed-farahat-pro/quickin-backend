import { NextResponse } from 'next/server'
import { checkStaffReset, markStaffResetUsed, setStaffPassword, getStaffByEmail } from '@/lib/local/db'
import { rateLimit } from '@/lib/local/auth'
import {
  hashStaffPassword,
  validateStaffPassword,
  revokeStaffSessions,
  logStaffAction,
  clientIpOf,
  MAX_RESET_ATTEMPTS,
} from '@/lib/local/staff'

// Step 2 of the staff password reset (A5).
//   POST /api/local/staff/reset-password { email, code, password } → { ok: true }
//
// The code is verified but NOT consumed until the new password is committed — the
// same Verify()/MarkUsed() ordering as HubDrives' PasswordResetRequest, so a failure
// while writing the password doesn't burn the operator's only code. A wrong code
// increments the attempt counter and the code dies after MAX_RESET_ATTEMPTS tries.
//
// On success every existing session for the account is revoked: a reset is exactly
// the moment you want other sign-ins killed.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

const REASONS: Record<string, string> = {
  not_found: 'No reset was requested for this email. Start again.',
  expired: 'That code has expired. Request a new one.',
  used: 'That code has already been used. Request a new one.',
  locked: 'Too many incorrect codes. Request a new one.',
  mismatch: 'That code is not correct.',
}

export async function POST(req: Request) {
  const ip = clientIpOf(req)
  try {
    const wait = rateLimit(`staff-reset:${ip}`, 20, 15 * 60_000)
    if (wait) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${wait}s.` },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(wait) } }
      )
    }

    const body = await req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim()
    const code = String(body.code ?? '').trim()
    const password = String(body.password ?? '')
    if (!email || !code || !password) {
      return NextResponse.json({ error: 'Email, code and new password are required' }, { status: 400, headers: NO_STORE })
    }

    const bad = validateStaffPassword(password, email)
    if (bad) return NextResponse.json({ error: bad }, { status: 400, headers: NO_STORE })

    const check = await checkStaffReset(email, code, MAX_RESET_ATTEMPTS)
    if (!check.ok) {
      await logStaffAction({
        staffId: null,
        staffEmail: email,
        action: 'reset_failed',
        detail: { reason: check.reason },
        ip,
      })
      return NextResponse.json(
        { error: REASONS[check.reason] ?? 'That code is not valid.' },
        { status: check.reason === 'locked' ? 429 : 400, headers: NO_STORE }
      )
    }

    const staff = await getStaffByEmail(email)
    if (!staff || !staff.is_active) {
      return NextResponse.json({ error: 'This account cannot be reset.' }, { status: 403, headers: NO_STORE })
    }

    const ok = await setStaffPassword(check.staffId, hashStaffPassword(password))
    if (!ok) {
      return NextResponse.json({ error: 'Could not set the password' }, { status: 500, headers: NO_STORE })
    }
    // Only now consume the code, and kill any other live sign-in.
    await markStaffResetUsed(check.id)
    const revoked = await revokeStaffSessions(check.staffId)
    await logStaffAction({
      staffId: check.staffId,
      staffEmail: staff.email,
      action: 'reset_completed',
      detail: { sessions_revoked: revoked },
      ip,
    })

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (err) {
    console.error('staff reset-password:', err)
    return NextResponse.json({ error: 'Could not reset the password', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}
