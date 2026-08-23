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

export async function GET() {
  // A RELATIVE Location, deliberately. The browser only ever reaches this route
  // through the web app's own `/api/*` rewrite, so `req.url` here is the BACKEND's
  // origin — `NextResponse.redirect(new URL('/explore', req.url))` sent people to
  // <backend>/explore, which is a 404 because the backend serves no pages.
  // A relative redirect is resolved by the browser against the URL it actually
  // typed (the web app's origin), so sign-out lands on the web app's /explore.
  const res = new NextResponse(null, {
    status: 302,
    headers: { Location: '/explore', 'Cache-Control': 'no-store' },
  })
  // Clear the auth cookie (match the path it was set on).
  res.cookies.set('qk_token', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
  return res
}
