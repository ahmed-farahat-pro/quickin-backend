import { NextResponse } from 'next/server'
import { verifyUserOtp, signToken } from '@/lib/local/auth'
import { recordReferral } from '@/lib/local/promote'

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

// POST /api/auth/verify-otp — { email, code } → on success, activates the account
// and returns { token, user } (also sets the qk_token cookie for web).
export async function POST(req: Request) {
  try {
    const { email, code, role, referral_code, referralCode } = await req.json()
    if (!email || !code) {
      return NextResponse.json({ error: 'Email and code are required' }, { status: 400, headers: CORS })
    }
    // role scopes to the correct (email, role) account when an email has both.
    const user = await verifyUserOtp(String(email).trim(), String(code).trim(), typeof role === 'string' ? role : undefined)
    if (!user) {
      return NextResponse.json({ error: 'Invalid or expired verification code' }, { status: 400, headers: CORS })
    }
    // If they signed up via a referral code, record it (mock reward to the owner).
    const refCode = referral_code ?? referralCode
    if (typeof refCode === 'string' && refCode.trim()) {
      await recordReferral(user.id, refCode).catch(() => {})
    }
    const token = signToken({ sub: user.id, email: user.email, role: user.role })
    const res = NextResponse.json({ token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    console.error('verify-otp failed:', err)
    return NextResponse.json({ error: 'Verification failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
