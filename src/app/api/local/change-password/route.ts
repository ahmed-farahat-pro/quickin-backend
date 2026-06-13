import { NextResponse } from 'next/server'
import { getUserFromRequest, changePassword, hashPassword } from '@/lib/local/auth'

// POST /api/local/change-password { current_password, new_password } — for a signed-in
// user changing their password from inside the profile (must supply the current one).
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
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.id === 'admin') return NextResponse.json({ error: 'The admin password is fixed' }, { status: 400, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const current = String(b.current_password ?? b.currentPassword ?? '')
    const next = String(b.new_password ?? b.newPassword ?? '')
    if (next.length < 6) {
      return NextResponse.json({ error: 'New password must be at least 6 characters' }, { status: 400, headers: CORS })
    }
    const ok = await changePassword(user.id, current, hashPassword(next), next)
    if (!ok) return NextResponse.json({ error: 'Your current password is incorrect' }, { status: 400, headers: CORS })
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to change password', detail: String(err) }, { status: 500, headers: CORS })
  }
}
