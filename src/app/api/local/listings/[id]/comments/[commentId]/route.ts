import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { deleteListingComment } from '@/lib/local/listing-comments'
import { CORS, commentErrorResponse, preflight } from '../_shared'

//   DELETE /api/local/listings/:id/comments/:commentId → { ok: true }   (the author, or an admin)
export const dynamic = 'force-dynamic'

export async function OPTIONS() {
  return preflight('DELETE')
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const { id, commentId } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    await deleteListingComment(id, commentId, user)
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    return commentErrorResponse(err, 'DELETE /api/local/listings/:id/comments/:commentId:')
  }
}
