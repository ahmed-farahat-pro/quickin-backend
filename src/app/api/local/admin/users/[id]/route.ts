import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminGetUserDetail, adminRemoveUserAvatar, adminSetAccountStatus, adminDeleteUser } from '@/lib/local/db'
import {
  nextStatusFor,
  normalizeReason,
  normalizeStatus,
  requiresSuperAdmin,
  UserInputError,
  USER_STATUS_ACTIONS,
  type UserStatusAction,
} from '@/lib/local/user-admin-core'

// One user, for the /ops profile screen.
//   GET  /api/local/admin/users/:id
//        → { user, listings, bookings, payments, conversations, documents, stats } (D2)
//   POST /api/local/admin/users/:id { action:'block'|'unblock'|'remove'|'restore'|'delete', reason? }
//        → the account lifecycle (D3 block, D4 remove). Every call is audited.
//   POST /api/local/admin/users/:id { action:'remove_photo' }
//        → takes the profile photo down and leaves the account alone.
//        → action:'delete' permanently removes the user row (hard delete) so the
//          email is free for re-signup. Requires super admin.
//
// `restore` and `delete` additionally require a super admin.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

/** Past-tense audit verb per action, e.g. 'user_blocked'. */
const AUDIT_ACTION: Record<string, string> = {
  block: 'user_blocked',
  unblock: 'user_unblocked',
  remove: 'user_removed',
  restore: 'user_restored',
  delete: 'user_deleted',
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'users')
  if ('error' in gate) return gate.error
  const { id } = await ctx.params
  try {
    const detail = await adminGetUserDetail(id)
    if (!detail) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: CORS })
    return NextResponse.json(detail, { headers: CORS })
  } catch (err) {
    console.error('admin user GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'users')
  if ('error' in gate) return gate.error
  const { id } = await ctx.params
  try {
    const body = await req.json().catch(() => null)
    // Read as a plain string: not every action here is a status transition.
    const requested = String(body?.action ?? '')

    // --- Hard delete (permanently remove the user row so the email is free) ---
    if (requested === 'delete') {
      if (gate.staff.role !== 'super_admin') {
        return NextResponse.json(
          { error: 'Only a super admin can permanently delete an account' },
          { status: 403, headers: CORS },
        )
      }
      const detail = await adminGetUserDetail(id)
      if (!detail) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: CORS })
      if (String(detail.user.role ?? '').toLowerCase() === 'admin') {
        return NextResponse.json({ error: 'Cannot delete an admin account' }, { status: 400, headers: CORS })
      }
      const reason = normalizeReason(body?.reason) || 'Permanently deleted by admin'
      await adminDeleteUser(id)
      await logStaffAction({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        action: 'user_deleted',
        targetType: 'user',
        targetId: id,
        detail: { email: detail.user.email, reason },
        ip: clientIpOf(req),
      })
      return NextResponse.json({ ok: true, deleted: true }, { headers: CORS })
    }

    // Taking a photo down is not an account-status change, so it is answered
    // before the status machine below rather than bolted into it: a reported
    // profile picture is a reason to remove the picture, and blocking the person
    // over it is a separate decision a moderator makes separately.
    if (requested === 'remove_photo') {
      const result = await adminRemoveUserAvatar(id)
      if (!result) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: CORS })
      // Audited even when there was nothing to remove: "a moderator opened this
      // profile and pressed Remove photo" is the fact worth keeping, and a photo
      // that was already gone by the time they pressed it is part of that story.
      await logStaffAction({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        action: 'user_photo_removed',
        targetType: 'user',
        targetId: id,
        detail: { email: result.email, had_photo: result.removed },
        ip: clientIpOf(req),
      })
      return NextResponse.json({ ok: true, removed: result.removed }, { headers: CORS })
    }

    // --- Lifecycle: block / unblock / remove / restore ---
    const action = requested as UserStatusAction
    if (!(USER_STATUS_ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json(
        { error: `action must be one of: ${[...USER_STATUS_ACTIONS, 'remove_photo', 'delete'].join(', ')}` },
        { status: 400, headers: CORS },
      )
    }
    if (requiresSuperAdmin(action) && gate.staff.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Only a super admin can restore a removed account' },
        { status: 403, headers: CORS },
      )
    }

    // Read the current status to validate the transition. Re-read inside the
    // transaction too (adminSetAccountStatus locks the row) — this is the friendly
    // 400, that is the correctness guarantee.
    const detail = await adminGetUserDetail(id)
    if (!detail) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: CORS })
    const current = normalizeStatus(detail.user.account_status)
    const next = nextStatusFor(current, action)
    const reason = normalizeReason(body?.reason)
    if ((action === 'block' || action === 'remove') && !reason) {
      return NextResponse.json({ error: 'A reason is required' }, { status: 400, headers: CORS })
    }

    const result = await adminSetAccountStatus(id, next, { reason, actor: staffActor(gate.staff) })

    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: AUDIT_ACTION[action],
      targetType: 'user',
      targetId: id,
      detail: {
        email: result.email,
        previous_status: result.previous,
        status: next,
        reason,
        listings_changed: result.listingsChanged,
      },
      ip: clientIpOf(req),
    })

    return NextResponse.json(
      { ok: true, status: next, listingsChanged: result.listingsChanged },
      { headers: CORS },
    )
  } catch (err) {
    if (err instanceof UserInputError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    const msg = err instanceof Error ? err.message : 'Could not update user'
    // adminSetAccountStatus refuses admin rows and unknown ids with readable errors.
    const status = /not found/i.test(msg) ? 404 : /admin account|Invalid user/i.test(msg) ? 400 : 500
    if (status === 500) console.error('admin user POST:', err)
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
