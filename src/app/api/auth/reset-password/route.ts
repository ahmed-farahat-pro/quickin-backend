import { NextResponse } from 'next/server'
import { resetPasswordWithOtp, hashPassword, signToken } from '@/lib/local/auth'

// POST /api/auth/reset-password { email, code, password } → verifies the reset code,
// sets the new password, and logs the user in (returns { token, user }).
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
    const { email, code, password, role } = await req.json()
    if (!email || !code || !password) {
      return NextResponse.json({ error: 'Email, code and new password are required' }, { status: 400, headers: CORS })
    }
    if (String(password).length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400, headers: CORS })
    }
    const user = await resetPasswordWithOtp(
      String(email).trim(),
      String(code).trim(),
      hashPassword(String(password)),
      String(password),
      typeof role === 'string' ? role : undefined
    )
    if (!user) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400, headers: CORS })
    const token = signToken({ sub: user.id, email: user.email, role: user.role })
    const res = NextResponse.json({ token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    return NextResponse.json({ error: 'Failed to reset password', detail: String(err) }, { status: 500, headers: CORS })
  }
}
