import { NextResponse } from 'next/server'
import { getStaffByEmail, setStaffPassword } from '@/lib/local/db'
import {
  getStaffFromRequest,
  hashStaffPassword,
  verifyStaffPassword,
  validateStaffPassword,
  revokeStaffSessions,
  logStaffAction,
  clientIpOf,
} from '@/lib/local/staff'

// Change your own admin password while signed in (A5).
//   POST /api/local/staff/change-password { current_password, new_password }
//
// Requires the current password, so a stolen cookie can't be used to take over the
// account. Other sessions are revoked; the caller's own session survives (exceptSid)
// so the operator isn't logged out of the tab they just used.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: Request) {
  try {
    const staff = await getStaffFromRequest(req)
    if (!staff) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: NO_STORE })
    }
    if (staff.legacy) {
      return NextResponse.json(
        { error: 'Legacy admin sessions have no staff password. Sign in with a staff account.' },
        { status: 400, headers: NO_STORE }
      )
    }

    const body = await req.json().catch(() => ({}))
    const current = String(body.current_password ?? body.currentPassword ?? '')
    const next = String(body.new_password ?? body.newPassword ?? '')
    if (!current || !next) {
      return NextResponse.json({ error: 'Current and new password are required' }, { status: 400, headers: NO_STORE })
    }

    const bad = validateStaffPassword(next, staff.email)
    if (bad) return NextResponse.json({ error: bad }, { status: 400, headers: NO_STORE })

    const row = await getStaffByEmail(staff.email)
    if (!row || !verifyStaffPassword(current, row.password_hash)) {
      await logStaffAction({
        staffId: staff.staffId,
        staffEmail: staff.email,
        action: 'change_password_failed',
        ip: clientIpOf(req),
      })
      return NextResponse.json({ error: 'Current password is not correct' }, { status: 401, headers: NO_STORE })
    }

    await setStaffPassword(staff.staffId, hashStaffPassword(next))
    const revoked = await revokeStaffSessions(staff.staffId, staff.sid)
    await logStaffAction({
      staffId: staff.staffId,
      staffEmail: staff.email,
      action: 'change_password',
      detail: { other_sessions_revoked: revoked },
      ip: clientIpOf(req),
    })

    return NextResponse.json({ ok: true, other_sessions_revoked: revoked }, { headers: NO_STORE })
  } catch (err) {
    console.error('staff change-password:', err)
    return NextResponse.json({ error: 'Could not change the password', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}
