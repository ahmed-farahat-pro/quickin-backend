import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { adminBroadcast } from '@/lib/local/admin'

// POST /api/local/admin/notify (admin) — fire a notification to users.
//   { title, body?, link?, audience?: 'all'|'guests'|'hosts', push?, email? }
// → in-app notification for each + FCM push (+ optional email). Returns { recipients }.
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
    const gate = await requireStaff(req, 'notify')
    if ('error' in gate) return gate.error
    const b = await req.json().catch(() => ({}))
    const result = await adminBroadcast({
      title: b.title,
      body: b.body,
      link: b.link,
      audience: b.audience,
      push: b.push !== false,
      email: Boolean(b.email),
    })
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: /required/i.test(msg) ? 400 : 500, headers: CORS })
  }
}
