import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminDeleteListingComment } from '@/lib/local/listing-comments'

// Staff moderation of public listing comments.
//   DELETE /api/local/admin/comments/:id → { ok: true }   (module: moderation; audited)
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'moderation')
  if ('error' in gate) return gate.error
  try {
    const { id } = await ctx.params
    const removed = await adminDeleteListingComment(id)
    if (!removed) return NextResponse.json({ error: 'Comment not found' }, { status: 404, headers: CORS })
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'comment_removed',
      targetType: 'listing_comment',
      targetId: id,
      detail: {},
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('DELETE /api/local/admin/comments/:id:', err)
    return NextResponse.json({ error: 'Failed to remove comment' }, { status: 500, headers: CORS })
  }
}
