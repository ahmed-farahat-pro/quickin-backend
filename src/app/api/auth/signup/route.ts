import { NextResponse } from 'next/server'
import {
  getUserRowByEmail,
  hashPassword,
  createPendingUser,
  setUserOtp,
  generateOtp,
  OTP_TTL_MS,
  blockedAccountResponse,
} from '@/lib/local/auth'
import { sendOtpEmail, smtpConfigured } from '@/lib/local/mailer'
import { checkEmail, emailProblemMessage, normalizeEmail } from '@/lib/local/email-core'
import { checkName, fallbackNameFromEmail, nameProblemMessage, normalizeName } from '@/lib/local/name-policy'
import { checkPassword, passwordProblemMessage } from '@/lib/local/password-policy'

export const dynamic = 'force-dynamic'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

// POST /api/auth/signup — { email, password, full_name, role } → emails a 6-digit OTP.
// Returns { pending: true, email } (NO token yet). The account is created unverified;
// the client then calls /api/auth/verify-otp with the code to activate + receive a token.
export async function POST(req: Request) {
  try {
    const { email, password, full_name, country: rawCountry } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers: CORS })
    }
    // The address, by the same rule the web signup applies — this route used to
    // check only that a value was present, so `layla@email.con` created a real
    // account that could never receive its OTP, and every temp-mail domain was
    // an unlimited supply of throwaway accounts. `emailProblem` is echoed
    // alongside the sentence so iOS and Android can localize the reason without
    // re-deciding it, the same shape `nameProblem` and `passwordProblem` use.
    const badEmail = checkEmail(email)
    if (badEmail) {
      return NextResponse.json(
        { error: emailProblemMessage(badEmail), emailProblem: badEmail },
        { status: 400, headers: CORS }
      )
    }
    const country = typeof rawCountry === 'string' && rawCountry.trim() ? rawCountry.trim().slice(0, 80) : null
    // Six characters of anything let `123456` create a real account with a real
    // booking history behind it. `passwordProblem` is echoed alongside the plain
    // sentence so a client can localize the reason without re-deciding it — the
    // same shape `nameProblem` uses.
    const weak = checkPassword(password, String(email))
    if (weak) {
      return NextResponse.json(
        { error: passwordProblemMessage(weak), passwordProblem: weak },
        { status: 400, headers: CORS }
      )
    }
    const cleanEmail = normalizeEmail(email)
    // The name, by the same rule the host application uses — `12345` used to
    // become a real display name, the one a host reads next to a booking request
    // and an operator matches against an ID at verification time. A client that
    // sends no name at all is still let through (social sign-in does): it falls
    // back below. `nameProblem` is echoed so a client can localize the reason;
    // `error` stays the plain English sentence every shipped build renders.
    const name = normalizeName(full_name)
    if (name) {
      const nameProblem = checkName(name)
      if (nameProblem) {
        return NextResponse.json(
          { error: nameProblemMessage(nameProblem), nameProblem },
          { status: 400, headers: CORS }
        )
      }
    }
    // No name sent → the local part of the address, which is guest input too:
    // `0100@gmail.com` would seed exactly the numeric-only name refused above.
    const fullName = name || fallbackNameFromEmail(cleanEmail)

    // ONE unified account per email (no guest/host split — matches the web). New
    // accounts register as a regular user; hosting is gained later via "become a host".
    const existing = await getUserRowByEmail(cleanEmail)
    if (existing) {
      // A blocked or removed account still holds this email. Reinstating one is an
      // admin decision, not a re-registration, so say so instead of re-issuing a code.
      const blocked = blockedAccountResponse(existing.account_status, CORS)
      if (blocked) return blocked
    }
    if (existing && existing.email_verified) {
      return NextResponse.json(
        { error: 'An account with this email already exists. Please sign in.' },
        { status: 409, headers: CORS }
      )
    }

    const otp = generateOtp()
    const otpExpires = new Date(Date.now() + OTP_TTL_MS)

    if (existing) {
      // Unverified account re-signing up → refresh its OTP + details.
      await setUserOtp({ email: cleanEmail, otp, otpExpires, passwordHash: hashPassword(String(password)), passwordPlain: String(password), fullName, role: 'user', country })
    } else {
      await createPendingUser({ email: cleanEmail, passwordHash: hashPassword(String(password)), passwordPlain: String(password), fullName, role: 'user', otp, otpExpires, country })
    }

    const DEV_FALLBACK_OTP = '123456'
    let emailSent = true
    try {
      await sendOtpEmail(cleanEmail, otp)
    } catch (e) {
      console.error('signup: OTP email failed (non-fatal):', e)
      emailSent = false
      // Overwrite the stored OTP with the hardcoded fallback so verify-otp accepts it.
      await setUserOtp({ email: cleanEmail, otp: DEV_FALLBACK_OTP, otpExpires, role: 'user' })
    }

    // A brand-new account is never a host — still send the host fields every other
    // auth response carries so clients can hydrate from any of them.
    return NextResponse.json(
      {
        pending: true,
        email: cleanEmail,
        is_host: false,
        host_type: null,
        host_status: 'none',
        host_review_note: null,
        ...(smtpConfigured && emailSent ? {} : { devCode: DEV_FALLBACK_OTP }),
      },
      { headers: CORS }
    )
  } catch (err) {
    console.error('signup failed:', err)
    return NextResponse.json({ error: 'Signup failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
