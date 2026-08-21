import { NextResponse } from 'next/server'
import {
  getStaffAccount,
  updateStaffAccount,
  setStaffModules,
  setStaffPassword,
  deleteStaffAccount,
  countActiveSuperAdmins,
} from '@/lib/local/db'
import {
  requireSuperAdmin,
  hashStaffPassword,
  validateStaffPassword,
  normalizeModules,
  revokeStaffSessions,
  logStaffAction,
  clientIpOf,
  type StaffSession,
} from '@/lib/local/staff'

// Edit one staff account (A2, A3) — super admin only.
//   PATCH  /api/local/staff/accounts/:id
//          { full_name?, role?, is_active?, modules?, password?, action?:'force_logout' }
//   DELETE /api/local/staff/accounts/:id
//
// Two guards matter more than anything else here, and both are enforced server-side
// because there is no shell on Vercel to recover from a lockout:
//   1. You cannot deactivate, demote or delete your OWN account.
//   2. You cannot remove the LAST active super admin.
// The /ops/staff UI hides these actions too, but that is cosmetic.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

/** True when the caller is acting on their own staff row. A legacy (users.role)
 *  session has a users.id, which can never match a staff_accounts.id. */
function isSelf(staff: StaffSession, targetId: string): boolean {
  return !staff.legacy && staff.staffId === targetId
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin(req)
  if ('error' in gate) return gate.error
  const { id } = await ctx.params

  try {
    const target = await getStaffAccount(id)
    if (!target) {
      return NextResponse.json({ error: 'Staff account not found' }, { status: 404, headers: NO_STORE })
    }

    const body = await req.json().catch(() => ({}))
    const wantsDeactivate = body.is_active === false
    const wantsDemote = body.role === 'moderator' && target.role === 'super_admin'
    const forceLogout = body.action === 'force_logout'

    // ---- Guard 1: never act destructively on yourself -----------------------
    if ((wantsDeactivate || wantsDemote) && isSelf(gate.staff, id)) {
      return NextResponse.json(
        { error: 'You cannot deactivate or demote your own account' },
        { status: 400, headers: NO_STORE }
      )
    }

    // ---- Guard 2: never strand the panel with no super admin ----------------
    if ((wantsDeactivate || wantsDemote) && target.role === 'super_admin' && target.is_active) {
      if ((await countActiveSuperAdmins(id)) === 0) {
        return NextResponse.json(
          { error: 'This is the last active super admin. Promote another account first.' },
          { status: 400, headers: NO_STORE }
        )
      }
    }

    const changed: string[] = []

    // ---- Profile / role / active state -------------------------------------
    const fullName = body.full_name ?? body.fullName
    const nextRole = body.role === 'super_admin' ? 'super_admin' : body.role === 'moderator' ? 'moderator' : undefined
    if (fullName !== undefined || nextRole !== undefined || body.is_active !== undefined) {
      await updateStaffAccount(id, {
        fullName: fullName === undefined ? undefined : String(fullName),
        role: nextRole,
        isActive: body.is_active === undefined ? undefined : Boolean(body.is_active),
      })
      if (fullName !== undefined) changed.push('full_name')
      if (nextRole !== undefined) changed.push('role')
      if (body.is_active !== undefined) changed.push('is_active')
    }

    // ---- Permissions (A3) ---------------------------------------------------
    // Promoting to super admin clears the rows: they're allowed everything anyway,
    // and leaving stale grants behind would resurface on a later demotion.
    if (body.modules !== undefined || nextRole === 'super_admin') {
      const modules = nextRole === 'super_admin' ? [] : normalizeModules(body.modules)
      await setStaffModules(id, modules, gate.staff.legacy ? null : gate.staff.staffId)
      changed.push('modules')
    }

    // ---- Password (A5 super-admin reset) ------------------------------------
    if (body.password !== undefined) {
      const password = String(body.password)
      const bad = validateStaffPassword(password, target.email)
      if (bad) return NextResponse.json({ error: bad }, { status: 400, headers: NO_STORE })
      await setStaffPassword(id, hashStaffPassword(password))
      changed.push('password')
    }

    // ---- Session revocation -------------------------------------------------
    // Deactivation, a password change, or an explicit force-logout kill live
    // sign-ins. A permissions change deliberately does NOT: modules are re-read on
    // every request, so it takes effect on the next click without the disruption.
    let revoked = 0
    if (wantsDeactivate || body.password !== undefined || forceLogout) {
      revoked = await revokeStaffSessions(id)
      if (forceLogout) changed.push('force_logout')
    }

    if (!changed.length) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400, headers: NO_STORE })
    }

    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'update_staff',
      targetType: 'staff_account',
      targetId: id,
      // Never log the password itself — only that it changed.
      detail: { changed, target_email: target.email, sessions_revoked: revoked },
      ip: clientIpOf(req),
    })

    return NextResponse.json(
      { account: await getStaffAccount(id), sessions_revoked: revoked },
      { headers: NO_STORE }
    )
  } catch (err) {
    console.error('staff account PATCH:', err)
    return NextResponse.json({ error: 'Could not update the account', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin(req)
  if ('error' in gate) return gate.error
  const { id } = await ctx.params

  try {
    const target = await getStaffAccount(id)
    if (!target) {
      return NextResponse.json({ error: 'Staff account not found' }, { status: 404, headers: NO_STORE })
    }
    if (isSelf(gate.staff, id)) {
      return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400, headers: NO_STORE })
    }
    if (target.role === 'super_admin' && target.is_active && (await countActiveSuperAdmins(id)) === 0) {
      return NextResponse.json(
        { error: 'This is the last active super admin. Promote another account first.' },
        { status: 400, headers: NO_STORE }
      )
    }

    // Permissions and sessions cascade; staff_audit_log keeps the denormalized email
    // so this account's history stays readable.
    await deleteStaffAccount(id)
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'delete_staff',
      targetType: 'staff_account',
      targetId: id,
      detail: { target_email: target.email, role: target.role },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (err) {
    console.error('staff account DELETE:', err)
    return NextResponse.json({ error: 'Could not delete the account', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}
