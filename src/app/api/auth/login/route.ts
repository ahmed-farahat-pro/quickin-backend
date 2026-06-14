import { NextResponse } from 'next/server'
import { getUserRowByEmail, verifyPassword, signToken } from '@/lib/local/auth'

export const dynamic = 'force-dynamic'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

// Hardcoded admin. Username defaults to "admin"; the password MUST be supplied via the
// ADMIN_PASSWORD env var (set it in .env locally and in Vercel → Project → Settings → Env).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

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

// POST /api/auth/login — { email, password }. Handles the hardcoded admin, blocks
// unverified email accounts (so the client can route to OTP), and returns role.
export async function POST(req: Request) {
  try {
    const { email, password, role } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers: CORS })
    }
    const ident = String(email).trim()

    // ---- Hardcoded admin (username + ADMIN_PASSWORD) ----
    if (ident === ADMIN_USERNAME) {
      if (!ADMIN_PASSWORD || String(password) !== ADMIN_PASSWORD) {
        return NextResponse.json({ error: 'Invalid admin credentials' }, { status: 401, headers: CORS })
      }
      const user = { id: 'admin', email: ADMIN_USERNAME, full_name: 'Administrator', provider: 'admin', avatar_url: null, role: 'admin' }
      const token = signToken({ sub: 'admin', email: ADMIN_USERNAME, role: 'admin' })
      const res = NextResponse.json({ token, user }, { headers: CORS })
      res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
      return res
    }

    // ---- Regular email/password user ----
    const row = await getUserRowByEmail(ident)
    if (!row || !verifyPassword(String(password), row.password_hash)) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401, headers: CORS })
    }
    if (!row.email_verified) {
      return NextResponse.json(
        { error: 'Please verify your email first', needsVerification: true, email: row.email },
        { status: 403, headers: CORS }
      )
    }
    // Role at sign-in. Hosting is NOT granted here — becoming a host requires the
    // dedicated host registration (its own OTP). So:
    //  - Pick "host" → only allowed if the account already holds host (or admin);
    //    otherwise tell them to register as a host. No silent upgrade.
    //  - Pick "user" (guest) → act as a guest this session even if the account can host.
    //  - No choice → use the account's stored role.
    const desired = role === 'host' ? 'host' : role === 'user' ? 'user' : null
    let activeRole: string = row.role
    if (desired === 'host') {
      if (row.role !== 'host' && row.role !== 'admin') {
        return NextResponse.json(
          {
            error: 'This account is not registered as a host yet. Register as a host to add hosting.',
            needsHostRegistration: true,
            email: row.email,
          },
          { status: 403, headers: CORS }
        )
      }
      activeRole = row.role
    } else if (desired === 'user' && row.role !== 'admin') {
      activeRole = 'user'
    }
    const user = { id: row.id, email: row.email, full_name: row.full_name, provider: row.provider, avatar_url: row.avatar_url, role: activeRole }
    const token = signToken({ sub: user.id, email: user.email, role: activeRole })
    const res = NextResponse.json({ token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    console.error('login failed:', err)
    return NextResponse.json({ error: 'Login failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
