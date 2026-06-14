import { NextResponse } from 'next/server'
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

// DEMO social sign-in. Real Google/Apple OAuth would verify an ID token here;
// for the local demo we accept the provider + profile and create/log in the user.
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const provider = body.provider === 'apple' ? 'apple' : body.provider === 'google' ? 'google' : null
    if (!provider) {
      return NextResponse.json({ error: 'provider must be "google" or "apple"' }, { status: 400, headers: CORS })
    }
    // Allow the client to pass a profile; otherwise mint a stable demo identity.
    const email: string = (body.email && String(body.email).trim()) || `demo.${provider}@quickin.local`
    const fullName: string = (body.full_name && String(body.full_name).trim()) ||
      (provider === 'apple' ? 'Nora Salem' : 'Omar Khaled')
    const avatarUrl: string | undefined = body.avatar_url

    const user = await upsertSocialUser({ email, fullName, provider, avatarUrl, role: body.role })
    const token = signToken({ sub: user.id, email: user.email })
    const res = NextResponse.json({ token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    console.error('social login failed:', err)
    return NextResponse.json({ error: 'Social login failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
