import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { deleteListingCommentReply, replyToListingComment } from '@/lib/local/listing-comments'
import { pendingWarningFor } from '@/lib/local/moderation'
import { warningGateBody, WARNING_GATE_STATUS } from '@/lib/local/moderation-core'
import { CORS, commentErrorResponse, preflight } from '../../_shared'

// The host's one reply to a comment.
//   PUT    /api/local/listings/:id/comments/:commentId/reply { body } → { comment }
//   DELETE /api/local/listings/:id/comments/:commentId/reply          → { comment }  (reply null)
export const dynamic = 'force-dynamic'

export async function OPTIONS() {
  return preflight('PUT,DELETE')
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const { id, commentId } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const warning = await pendingWarningFor(user.id)
    if (warning) return NextResponse.json(warningGateBody(warning), { status: WARNING_GATE_STATUS, headers: CORS })
    const body = await req.json().catch(() => ({}))
    const comment = await replyToListingComment(id, commentId, user.id, body?.body)
    return NextResponse.json({ comment }, { headers: CORS })
  } catch (err) {
    return commentErrorResponse(err, 'PUT /api/local/listings/:id/comments/:commentId/reply:')
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const { id, commentId } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const comment = await deleteListingCommentReply(id, commentId, user.id)
    return NextResponse.json({ comment }, { headers: CORS })
  } catch (err) {
    return commentErrorResponse(err, 'DELETE /api/local/listings/:id/comments/:commentId/reply:')
  }
}
