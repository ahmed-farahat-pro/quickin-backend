import { NextResponse } from 'next/server'
import { getUserRowByEmail, setUserOtp, generateOtp, OTP_TTL_MS } from '@/lib/local/auth'
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

// POST /api/auth/resend-otp — { email } → re-issues + re-sends the OTP for a pending account.
export async function POST(req: Request) {
  try {
    const { email } = await req.json()
    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400, headers: CORS })
    }
    const cleanEmail = String(email).trim()
    const existing = await getUserRowByEmail(cleanEmail)
    if (!existing) {
      return NextResponse.json({ error: 'No pending account for this email' }, { status: 404, headers: CORS })
    }
    if (existing.email_verified) {
      return NextResponse.json({ error: 'This email is already verified — please log in' }, { status: 400, headers: CORS })
    }
    const otp = generateOtp()
    const otpExpires = new Date(Date.now() + OTP_TTL_MS)
    await setUserOtp({ email: cleanEmail, otp, otpExpires })
    await sendOtpEmail(cleanEmail, otp)
    return NextResponse.json({ pending: true, email: cleanEmail, ...(smtpConfigured ? {} : { devCode: otp }) }, { headers: CORS })
  } catch (err) {
    console.error('resend-otp failed:', err)
    return NextResponse.json({ error: 'Could not resend code', detail: String(err) }, { status: 500, headers: CORS })
  }
}
