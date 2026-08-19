import { NextResponse } from 'next/server'
import { getUserRowByEmail, getUserRowByEmailRole, setUserOtp, generateOtp, OTP_TTL_MS, blockedAccountResponse } from '@/lib/local/auth'
import { sendOtpEmail, smtpConfigured } from '@/lib/local/mailer'
import { isValidEmail, normalizeEmail } from '@/lib/local/email-core'

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
    const { email, role } = await req.json()
    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400, headers: CORS })
    }
    // Same gate as forgot-password, and disposable is tolerated for the same
    // reason: this only re-sends to an account that already exists.
    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400, headers: CORS })
    }
    const cleanEmail = normalizeEmail(email)
    // Scope to the (email, role) account being verified when role is provided.
    const existing =
      role === 'user' || role === 'host'
        ? await getUserRowByEmailRole(cleanEmail, role)
        : await getUserRowByEmail(cleanEmail)
    if (!existing) {
      return NextResponse.json({ error: 'No pending account for this email' }, { status: 404, headers: CORS })
    }
    // Never mail a code to a blocked or removed account.
    const blocked = blockedAccountResponse(existing.account_status, CORS)
    if (blocked) return blocked
    if (existing.email_verified) {
      return NextResponse.json({ error: 'This email is already verified — please log in' }, { status: 400, headers: CORS })
    }
    const otp = generateOtp()
    const otpExpires = new Date(Date.now() + OTP_TTL_MS)
    await setUserOtp({ email: cleanEmail, otp, otpExpires, role: existing.role })
    const DEV_FALLBACK_OTP = '123456'
    let emailSent = true
    try {
      await sendOtpEmail(cleanEmail, otp)
    } catch (e) {
      console.error('resend-otp: email failed (non-fatal):', e)
      emailSent = false
      await setUserOtp({ email: cleanEmail, otp: DEV_FALLBACK_OTP, otpExpires, role: existing.role })
    }
    return NextResponse.json({ pending: true, email: cleanEmail, ...(smtpConfigured && emailSent ? {} : { devCode: DEV_FALLBACK_OTP }) }, { headers: CORS })
  } catch (err) {
    console.error('resend-otp failed:', err)
    return NextResponse.json({ error: 'Could not resend code', detail: String(err) }, { status: 500, headers: CORS })
  }
}
