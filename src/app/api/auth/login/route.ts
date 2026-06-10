import { NextResponse } from 'next/server'
import { getUserRowByEmail, verifyPassword, signToken } from '@/lib/local/auth'

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

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers: CORS })
    }
    const row = await getUserRowByEmail(String(email).trim())
    if (!row || !verifyPassword(String(password), row.password_hash)) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401, headers: CORS })
    }
    const user = { id: row.id, email: row.email, full_name: row.full_name, provider: row.provider, avatar_url: row.avatar_url }
    const token = signToken({ sub: user.id, email: user.email })
    const res = NextResponse.json({ token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    console.error('login failed:', err)
    return NextResponse.json({ error: 'Login failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
