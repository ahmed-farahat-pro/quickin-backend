import { NextResponse } from 'next/server'
import { verifyAppleIdToken, oauthConfigured } from '@/lib/local/oauth'
import { upsertSocialUser, signToken } from '@/lib/local/auth'

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

// REAL Sign in with Apple. Accepts Apple's identity token (id_token) and the
// optional full name (Apple only returns the name on the FIRST authorization,
// so the client forwards it). Verifies against Apple's JWKS, then logs in.
export async function POST(req: Request) {
  try {
    if (!oauthConfigured.apple()) {
      return NextResponse.json(
        { error: 'Apple sign-in is not configured. Set APPLE_CLIENT_ID in .env.local.' },
        { status: 501, headers: CORS }
      )
    }
    const body = await req.json()
    const idToken = body.id_token || body.identityToken || body.credential
    if (!idToken) {
      return NextResponse.json({ error: 'Missing Apple identity token' }, { status: 400, headers: CORS })
    }

    const claims = await verifyAppleIdToken(String(idToken))
    if (!claims.email) {
      return NextResponse.json({ error: 'Apple token has no email' }, { status: 400, headers: CORS })
    }

    const fullName =
      (body.full_name && String(body.full_name).trim()) ||
      (body.fullName && String(body.fullName).trim()) ||
      String(claims.email).split('@')[0]

    const user = await upsertSocialUser({
      email: String(claims.email),
      fullName,
      provider: 'apple',
    })
    const token = signToken({ sub: user.id, email: user.email, role: user.role })
    const res = NextResponse.json({ token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    console.error('apple auth failed:', err)
    return NextResponse.json(
      { error: 'Apple sign-in failed', detail: String(err instanceof Error ? err.message : err) },
      { status: 401, headers: CORS }
    )
  }
}
