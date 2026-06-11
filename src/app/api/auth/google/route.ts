import { NextResponse } from 'next/server'
import { verifyGoogleIdToken, oauthConfigured } from '@/lib/local/oauth'
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

// REAL Google sign-in. Accepts the Google ID token (`credential` from Google
// Identity Services on web, or the id_token from the native flow), verifies it
// against Google's JWKS, then creates/logs in the user.
export async function POST(req: Request) {
  try {
    if (!oauthConfigured.google()) {
      return NextResponse.json(
        { error: 'Google sign-in is not configured. Set GOOGLE_CLIENT_ID in .env.local.' },
        { status: 501, headers: CORS }
      )
    }
    const body = await req.json()
    const idToken = body.credential || body.id_token || body.idToken
    if (!idToken) {
      return NextResponse.json({ error: 'Missing Google credential' }, { status: 400, headers: CORS })
    }

    const claims = await verifyGoogleIdToken(String(idToken))
    if (!claims.email) {
      return NextResponse.json({ error: 'Google account has no email' }, { status: 400, headers: CORS })
    }

    const user = await upsertSocialUser({
      email: String(claims.email),
      fullName: String(claims.name || String(claims.email).split('@')[0]),
      provider: 'google',
      avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
    })
    const token = signToken({ sub: user.id, email: user.email, role: user.role })
    const res = NextResponse.json({ token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    console.error('google auth failed:', err)
    return NextResponse.json(
      { error: 'Google sign-in failed', detail: String(err instanceof Error ? err.message : err) },
      { status: 401, headers: CORS }
    )
  }
}
