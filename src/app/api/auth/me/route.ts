import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { verifyToken, getUserById } from '@/lib/local/auth'

export const dynamic = 'force-dynamic'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

// GET /api/auth/me — resolves the current user from a Bearer token or qk_token cookie.
export async function GET(req: Request) {
  try {
    const auth = req.headers.get('authorization') || ''
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : null
    const cookieToken = (await cookies()).get('qk_token')?.value || null
    const token = bearer || cookieToken
    if (!token) return NextResponse.json({ user: null }, { headers: CORS })

    const claims = verifyToken(token)
    if (!claims) return NextResponse.json({ user: null }, { headers: CORS })

    // Hardcoded admin token has no DB row.
    if (claims.role === 'admin' && claims.sub === 'admin') {
      return NextResponse.json(
        { user: { id: 'admin', email: claims.email, full_name: 'Administrator', provider: 'admin', avatar_url: null, role: 'admin' } },
        { headers: CORS }
      )
    }

    const row = await getUserById(claims.sub)
    if (!row) return NextResponse.json({ user: null }, { headers: CORS })

    return NextResponse.json(
      { user: { id: row.id, email: row.email, full_name: row.full_name, provider: row.provider, avatar_url: row.avatar_url, role: row.role } },
      { headers: CORS }
    )
  } catch (err) {
    return NextResponse.json({ user: null, error: String(err) }, { status: 200, headers: CORS })
  }
}
