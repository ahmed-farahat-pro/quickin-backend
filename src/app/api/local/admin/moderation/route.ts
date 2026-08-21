import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf, staffActor } from '@/lib/local/staff'
import {
  adminListFlaggedUsers,
  adminUserViolations,
  adminUserWarnings,
  adminIssueWarning,
  adminMarkViolationsReviewed,
} from '@/lib/local/moderation'
import { adminSetAccountStatus } from '@/lib/local/db'
import { isModerationAction, normalizeWarning, auditActionFor } from '@/lib/local/moderation-core'

// Moderation (F5) — users the content guard caught trying to share contact details.
//   GET  /api/local/admin/moderation?scope=open|all      → { users }
//   GET  /api/local/admin/moderation?userId=…            → { violations, warnings }
//   POST /api/local/admin/moderation { userId, action, message?, reason? }
//        action: 'warn' | 'suspend' | 'dismiss'
//
// All three actions close the user's outstanding rows, which is what drains the
// alert — an alert that only ever climbs is one people learn to ignore.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'moderation')
  if ('error' in gate) return gate.error
  try {
    const url = new URL(req.url)
    const userId = url.searchParams.get('userId')
    if (userId) {
      // Reading someone's attempts means reading what they wrote, so the read is
      // audited — the same rule documents already follow.
      await logStaffAction({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        action: 'moderation_viewed',
        targetType: 'user',
        targetId: userId,
        detail: {},
        ip: clientIpOf(req),
      })
      const [violations, warnings] = await Promise.all([
        adminUserViolations(userId),
        adminUserWarnings(userId),
      ])
      return NextResponse.json({ violations, warnings }, { headers: CORS })
    }
    const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'open'
    return NextResponse.json({ users: await adminListFlaggedUsers(scope), scope }, { headers: CORS })
  } catch (err) {
    console.error('admin moderation GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'moderation')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const userId = String(body?.userId ?? '')
    const action = String(body?.action ?? '')
    if (!userId || !isModerationAction(action)) {
      return NextResponse.json(
        { error: "userId and action:'warn'|'suspend'|'dismiss' required" },
        { status: 400, headers: CORS },
      )
    }
    const actor = staffActor(gate.staff)

    if (action === 'warn') {
      const message = normalizeWarning(body?.message)
      const result = await adminIssueWarning(userId, message, actor)
      await logStaffAction({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        action: auditActionFor('warn'),
        targetType: 'user',
        targetId: userId,
        detail: { message, alreadyPending: result.alreadyPending, reviewed: result.reviewed },
        ip: clientIpOf(req),
      })
      return NextResponse.json(
        { ok: true, warningId: result.id, alreadyPending: result.alreadyPending, reviewed: result.reviewed },
        { headers: CORS },
      )
    }

    if (action === 'suspend') {
      // Reuses the existing account-status lifecycle rather than inventing a
      // second kind of suspension: listings hide and unhide, the token check in
      // getUserFromRequest already refuses them, and /ops → Users can lift it.
      const reason = String(body?.reason ?? '').trim() || 'Repeatedly tried to share contact details in chat'
      const res = await adminSetAccountStatus(userId, 'blocked', { reason, actor })
      const reviewed = await adminMarkViolationsReviewed(userId, actor)
      await logStaffAction({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        action: auditActionFor('suspend'),
        targetType: 'user',
        targetId: userId,
        detail: { reason, previous: res.previous, listingsChanged: res.listingsChanged, reviewed },
        ip: clientIpOf(req),
      })
      return NextResponse.json({ ok: true, ...res, reviewed }, { headers: CORS })
    }

    const reviewed = await adminMarkViolationsReviewed(userId, actor)
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: auditActionFor('dismiss'),
      targetType: 'user',
      targetId: userId,
      detail: { reviewed },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true, reviewed }, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('admin moderation POST:', err)
    // adminSetAccountStatus throws user-facing messages ("Cannot change the status
    // of an admin account") that the operator needs to read.
    const status = /not found|Invalid|admin account/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: status === 400 ? msg : 'Action failed' }, { status, headers: CORS })
  }
}
