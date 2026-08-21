import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminSearchUsers, adminActivateUser, adminSetHost } from '@/lib/local/db'
import { parseUserListFilter, UserInputError } from '@/lib/local/user-admin-core'

// Admin (staff session + module permission):
//   GET  ?q=&status=&role=&from=&to=&sort=&limit=&offset=
//        → { users, total, filter } — the /ops Users directory (D1).
//   POST { id, action:'activate'|'make-host'|'remove-host' }
//        → the non-lifecycle actions. Block / remove / restore live on
//          /api/local/admin/users/[id], which needs the current status to validate
//          the transition.
//
// NOTE: the old `action:'delete'` (a hard DELETE of the user AND their listings) is
// deliberately gone. /ops blocks or removes instead — reversible, and it keeps the
// booking and payment history a dispute needs. Self-service deletion for the app
// stores is unaffected; that is DELETE /api/local/account.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'users')
  if ('error' in gate) return gate.error
  try {
    const url = new URL(req.url)
    const filter = parseUserListFilter((k) => url.searchParams.get(k))
    const { users, total } = await adminSearchUsers(filter)
    // Echo the filter back so the client can tell what it actually got.
    return NextResponse.json({ users, total, filter }, { headers: CORS })
  } catch (err) {
    if (err instanceof UserInputError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    console.error('admin users GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'users')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const id = body?.id
    const action = body?.action
    const allowed = ['activate', 'make-host', 'remove-host']
    if (!id || !allowed.includes(action)) {
      return NextResponse.json(
        { error: "id and action:'activate'|'make-host'|'remove-host' required" },
        { status: 400, headers: CORS },
      )
    }
    if (action === 'make-host') await adminSetHost(id, true)
    else if (action === 'remove-host') await adminSetHost(id, false)
    else await adminActivateUser(id)

    // User mutations went unaudited until now — every one of them leaves a trail.
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: action === 'activate' ? 'user_activate_email' : 'user_set_host',
      targetType: 'user',
      targetId: id,
      detail: action === 'activate' ? {} : { is_host: action === 'make-host' },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('admin users POST:', err)
    return NextResponse.json({ error: 'Could not update user' }, { status: 500, headers: CORS })
  }
}
