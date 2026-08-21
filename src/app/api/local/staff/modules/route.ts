import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/local/staff'
import { GRANTABLE_MODULES, STAFF_MODULES } from '@/lib/local/staff'

// The permission catalog for the /ops/staff checkbox grid (A3).
//   GET /api/local/staff/modules → { modules, grantable }
//
// `grantable` excludes super-admin-only modules (currently 'staff'), which is what
// the picker renders — a moderator can never be granted the ability to manage staff.
// Kept in code rather than a DB table: see the note on STAFF_MODULES.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireSuperAdmin(req)
  if ('error' in gate) return gate.error
  return NextResponse.json(
    { modules: STAFF_MODULES, grantable: GRANTABLE_MODULES },
    { headers: NO_STORE }
  )
}
