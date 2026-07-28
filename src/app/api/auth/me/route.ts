import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { verifyToken, getUserById } from '@/lib/local/auth'
import { getHostState } from '@/lib/local/db'

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
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

// GET /api/auth/me — resolves the current user from a Bearer token or qk_token cookie.
// Also returns the authoritative host fields (is_host / host_type / host_status /
// host_review_note): clients re-read them on every launch to decide whether to show
// host surfaces, so host state survives an app restart.
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
        {
          user: {
            id: 'admin', email: claims.email, full_name: 'Administrator', provider: 'admin', avatar_url: null, role: 'admin',
            is_host: false, host_type: null, host_status: 'none', host_review_note: null,
          },
        },
        { headers: CORS }
      )
    }

    const row = await getUserById(claims.sub)
    if (!row) return NextResponse.json({ user: null }, { headers: CORS })

    const host = await getHostState(row.id)
    return NextResponse.json(
      { user: { id: row.id, email: row.email, full_name: row.full_name, provider: row.provider, avatar_url: row.avatar_url, role: row.role, ...host } },
      { headers: CORS }
    )
  } catch (err) {
    return NextResponse.json({ user: null, error: String(err) }, { status: 200, headers: CORS })
  }
}
