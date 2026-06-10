import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

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

export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL('/explore', req.url))
  // Clear the auth cookie (match the path it was set on).
  res.cookies.set('qk_token', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
  return res
}
