import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  getUserRowByEmail,
  verifyPassword,
  updatePassword,
} from '@/lib/local/auth'
import { checkPassword, passwordProblemMessage } from '@/lib/local/password-policy'

// Change the signed-in user's password (no Supabase).
//   POST /api/auth/change-password { currentPassword, newPassword } → { ok: true }
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: CORS })
    const currentPassword = String(body.currentPassword ?? '')
    const newPassword = String(body.newPassword ?? '')
    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'currentPassword and newPassword are required' }, { status: 400, headers: CORS })
    }
    // Same policy as signup and reset — the three paths that set a password
    // share one floor, or the weakest of them is the real one.
    const weak = checkPassword(newPassword, user.email)
    if (weak) {
      return NextResponse.json(
        { error: passwordProblemMessage(weak), passwordProblem: weak },
        { status: 400, headers: CORS }
      )
    }
    const row = await getUserRowByEmail(user.email)
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400, headers: CORS })
    }
    await updatePassword(user.id, newPassword)
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('POST /api/auth/change-password failed:', err)
    return NextResponse.json({ error: String(err) }, { status: 500, headers: CORS })
  }
}
