import { NextResponse } from 'next/server'
import { verifyUserOtp, signToken } from '@/lib/local/auth'

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
    const { email, code } = await req.json()
    if (!email || !code) {
      return NextResponse.json({ error: 'Email and code are required' }, { status: 400, headers: CORS })
    }
    const user = await verifyUserOtp(String(email).trim(), String(code).trim())
    if (!user) {
      return NextResponse.json({ error: 'Invalid or expired verification code' }, { status: 400, headers: CORS })
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
