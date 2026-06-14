import { NextResponse } from 'next/server'
import { getUserRowByEmail, getUserRowByEmailRole, setResetOtp, generateOtp, OTP_TTL_MS } from '@/lib/local/auth'
import { sendOtpEmail, smtpConfigured } from '@/lib/local/mailer'

// POST /api/auth/forgot-password { email } → emails a 6-digit reset code.
// Returns { sent: true } regardless of whether the email exists (no account-existence
// leak); when the account exists and SMTP is off, devCode is included for testing.
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
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function POST(req: Request) {
  try {
    const { email, role } = await req.json()
    if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400, headers: CORS })
    const clean = String(email).trim()
    const existing =
      role === 'user' || role === 'host'
        ? await getUserRowByEmailRole(clean, role)
        : await getUserRowByEmail(clean)
    if (existing) {
      const otp = generateOtp()
      await setResetOtp(clean, otp, new Date(Date.now() + OTP_TTL_MS), existing.role)
      await sendOtpEmail(clean, otp)
      return NextResponse.json({ sent: true, ...(smtpConfigured ? {} : { devCode: otp }) }, { headers: CORS })
    }
    return NextResponse.json({ sent: true }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to start reset', detail: String(err) }, { status: 500, headers: CORS })
  }
}
