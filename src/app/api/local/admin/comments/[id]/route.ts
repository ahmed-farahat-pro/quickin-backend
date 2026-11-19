import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import {
  adminKeepComment,
  adminRemoveComment,
  adminRemoveReply,
  adminRestoreComment,
} from '@/lib/local/listing-comments'
import { normalizeAdminAction } from '@/lib/local/listing-comments-core'

// Staff moderation of one public listing comment. Module: moderation; audited.
//   DELETE /api/local/admin/comments/:id              { reason? } → { ok: true }
//          Removes the comment and notifies its author (type 'comment_removed').
//   DELETE /api/local/admin/comments/:id?part=reply               → { ok: true }
//          Removes only the host's reply; the question stays up.
//   PATCH  /api/local/admin/comments/:id  { action: 'keep' }    → { ok: true }
//          Marks a live comment reviewed: it leaves the To review queue and stays up.
//   PATCH  /api/local/admin/comments/:id  { action: 'restore' } → { ok: true }
//          Puts back a comment STAFF removed (never one its author deleted). No
//          notification; it counts as reviewed.
// Banning the author is not here: it is the existing moderation 'suspend' action
// (POST /api/local/admin/moderation), the same reversible block /ops → Users lifts.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'moderation')
  if ('error' in gate) return gate.error
  try {
    const { id } = await ctx.params
    const replyOnly = new URL(req.url).searchParams.get('part') === 'reply'
    const body = await req.json().catch(() => ({}))
    const audit = {
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      targetType: 'listing_comment',
      targetId: id,
      ip: clientIpOf(req),
    }
    if (replyOnly) {
      const res = await adminRemoveReply(id)
      if (!res) return NextResponse.json({ error: 'No reply to remove' }, { status: 404, headers: CORS })
      await logStaffAction({ ...audit, action: 'comment_reply_removed', detail: { listingId: res.listing_id } })
      return NextResponse.json({ ok: true }, { headers: CORS })
    }
    const res = await adminRemoveComment(id, body?.reason)
    if (!res) return NextResponse.json({ error: 'Comment not found' }, { status: 404, headers: CORS })
    await logStaffAction({
      ...audit,
      action: 'comment_removed',
      detail: { listingId: res.listing_id, authorId: res.user_id, reason: res.reason },
    })
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('DELETE /api/local/admin/comments/:id:', err)
    return NextResponse.json({ error: 'Failed to remove' }, { status: 500, headers: CORS })
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'moderation')
  if ('error' in gate) return gate.error
  try {
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const action = normalizeAdminAction(body?.action)
    if (!action) {
      return NextResponse.json({ error: "action must be 'keep' or 'restore'" }, { status: 400, headers: CORS })
    }
    const res = action === 'keep'
      ? await adminKeepComment(id, gate.staff.email)
      : await adminRestoreComment(id, gate.staff.email)
    if (!res) {
      const error = action === 'keep'
        ? 'Comment not found, or it was already removed'
        : 'Only a comment staff removed can be restored'
      return NextResponse.json({ error }, { status: 404, headers: CORS })
    }
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      targetType: 'listing_comment',
      targetId: id,
      ip: clientIpOf(req),
      action: action === 'keep' ? 'comment_kept' : 'comment_restored',
      detail: { listingId: res.listing_id, authorId: res.user_id },
    })
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('PATCH /api/local/admin/comments/:id:', err)
    return NextResponse.json({ error: 'Failed to update' }, { status: 500, headers: CORS })
  }
}
