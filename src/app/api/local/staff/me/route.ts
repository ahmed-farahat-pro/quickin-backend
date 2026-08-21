import { NextResponse } from 'next/server'
import { getStaffFromRequest, staffCan, STAFF_MODULES, STAFF_IDLE_MS } from '@/lib/local/staff'

// Who am I, and what may I use (A3/A4).
//   GET /api/local/staff/me → { staff: {...} | null, modules: [catalog] }
//
// `staff.can` is the operator's EFFECTIVE permissions — every module key staffCan()
// returns true for, resolved here. The web console renders from it instead of
// re-implementing the predicate, which matters because the rule is not just
// "is the key in modules": a super admin holds everything, and some modules are
// super-admin-only however the grants read. Duplicating that in the UI is exactly the
// kind of drift the two projects are being merged to stop.
//
// Always 200 with `staff: null` when signed out, matching the guest /api/auth/me
// contract, so a client can poll it to detect an expired/revoked session without
// treating a 401 as a network error. The console uses this to notice that its
// permissions changed under it.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  try {
    const staff = await getStaffFromRequest(req)
    return NextResponse.json(
      {
        staff: staff
          ? {
              id: staff.staffId,
              email: staff.email,
              full_name: staff.fullName,
              role: staff.role,
              modules: staff.modules,
              can: STAFF_MODULES.map((m) => m.key).filter((k) => staffCan(staff, k as never)),
              legacy: Boolean(staff.legacy),
            }
          : null,
        modules: STAFF_MODULES,
        // The console runs an idle-logout timer off this. Sent from here so the UI
        // counts down to the SAME deadline the server enforces — a second copy of
        // STAFF_IDLE_MINUTES in the web app would drift the moment one is retuned.
        idleMs: STAFF_IDLE_MS,
      },
      { headers: NO_STORE }
    )
  } catch (err) {
    console.error('staff me:', err)
    return NextResponse.json({ staff: null, modules: STAFF_MODULES }, { headers: NO_STORE })
  }
}
