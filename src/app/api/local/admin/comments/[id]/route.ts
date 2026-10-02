import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminRemoveComment, adminRemoveReply } from '@/lib/local/listing-comments'

// Staff moderation of one public listing comment. Module: moderation; audited.
//   DELETE /api/local/admin/comments/:id              { reason? } → { ok: true }
//          Removes the comment and notifies its author (type 'comment_removed').
//   DELETE /api/local/admin/comments/:id?part=reply               → { ok: true }
//          Removes only the host's reply; the question stays up.
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
