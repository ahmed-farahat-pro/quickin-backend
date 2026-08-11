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
    const country = typeof rawCountry === 'string' && rawCountry.trim() ? rawCountry.trim().slice(0, 80) : null
    if (String(password).length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400, headers: CORS })
    }
    const cleanEmail = String(email).trim()
    const fullName = String(full_name || '').trim() || cleanEmail.split('@')[0]

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

    let emailSent = true
    try {
      await sendOtpEmail(cleanEmail, otp)
    } catch (e) {
      console.error('signup: OTP email failed (non-fatal):', e)
      emailSent = false
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
        ...(smtpConfigured && emailSent ? {} : { devCode: otp }),
      },
      { headers: CORS }
    )
  } catch (err) {
    console.error('signup failed:', err)
    return NextResponse.json({ error: 'Signup failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
