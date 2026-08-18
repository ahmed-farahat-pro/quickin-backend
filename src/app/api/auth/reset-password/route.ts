import { NextResponse } from 'next/server'
import { recordLogin } from '@/lib/local/db'
import { resetPasswordWithOtp, hashPassword, signToken } from '@/lib/local/auth'
import { checkPassword, passwordProblemMessage } from '@/lib/local/password-policy'

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
    // A reset is exactly where people reach for the most guessable thing they can
    // remember, so the account's own address is passed in and refused too. Same
    // policy as signup and /api/local/change-password — a floor only one of the
    // three enforces is not a floor.
    const weak = checkPassword(password, String(email))
    if (weak) {
      return NextResponse.json(
        { error: passwordProblemMessage(weak), passwordProblem: weak },
        { status: 400, headers: CORS }
      )
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
    // F1: the one activity event nothing else records. Best-effort.
    await recordLogin(user.id, 'password', req)
    const res = NextResponse.json({ token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    return NextResponse.json({ error: 'Failed to reset password', detail: String(err) }, { status: 500, headers: CORS })
  }
}
