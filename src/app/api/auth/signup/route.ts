import { NextResponse } from 'next/server'
import {
  getUserRowByEmail,
  hashPassword,
  createPendingUser,
  setUserOtp,
  generateOtp,
  OTP_TTL_MS,
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

    await sendOtpEmail(cleanEmail, otp)

    return NextResponse.json(
      { pending: true, email: cleanEmail, ...(smtpConfigured ? {} : { devCode: otp }) },
      { headers: CORS }
    )
  } catch (err) {
    console.error('signup failed:', err)
    return NextResponse.json({ error: 'Signup failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
