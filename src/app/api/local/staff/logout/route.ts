import { NextResponse } from 'next/server'
import {
  getStaffFromRequest,
  revokeStaffSession,
  logStaffAction,
  clientIpOf,
  staffCookieOptions,
  STAFF_COOKIE,
} from '@/lib/local/staff'

// Admin-panel sign-out (A5 secure sessions).
//   POST /api/local/staff/logout → clears the cookie AND revokes the session row
//
// Unlike the guest /api/auth/logout (which only clears the cookie, leaving the
// bearer token valid), this actually invalidates the session server-side, so a
// copied cookie is useless afterwards.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: Request) {
  try {
    const staff = await getStaffFromRequest(req)
    if (staff && staff.sid !== 'legacy') {
      await revokeStaffSession(staff.sid)
      await logStaffAction({
        staffId: staff.legacy ? null : staff.staffId,
        staffEmail: staff.email,
        action: 'logout',
        detail: { sid: staff.sid },
        ip: clientIpOf(req),
      })
    }
  } catch (err) {
    // Never block sign-out: the cookie clear below is what the operator needs.
    console.error('staff logout:', err)
  }
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE })
  res.cookies.set(STAFF_COOKIE, '', { ...staffCookieOptions(0), maxAge: 0 })
  return res
}
