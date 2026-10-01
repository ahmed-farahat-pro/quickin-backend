import { NextResponse } from 'next/server'
import { getUserFromRequest, rateLimit } from '@/lib/local/auth'
import { createListingComment, getListingComments } from '@/lib/local/listing-comments'
import { COMMENT_RATE_MAX, COMMENT_RATE_WINDOW_MS } from '@/lib/local/listing-comments-core'
import { pendingWarningFor } from '@/lib/local/moderation'
import { warningGateBody, WARNING_GATE_STATUS } from '@/lib/local/moderation-core'
import { CORS, commentErrorResponse, preflight } from './_shared'

// Public comments on a listing (replaced host ⇄ guest messaging).
//   GET  /api/local/listings/:id/comments          → { comments, is_host, can_comment }  (auth optional)
//   POST /api/local/listings/:id/comments { body } → 201 { comment }                    (signed in)
export const dynamic = 'force-dynamic'

export async function OPTIONS() {
  return preflight('GET,POST')
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    return NextResponse.json(await getListingComments(id, user?.id ?? null), { headers: CORS })
  } catch (err) {
    return commentErrorResponse(err, 'GET /api/local/listings/:id/comments:')
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in to comment' }, { status: 401, headers: CORS })
    // The acknowledge gate a moderator's warning sets — it used to guard chat,
    // and comments are where that conversation moved.
    const warning = await pendingWarningFor(user.id)
    if (warning) return NextResponse.json(warningGateBody(warning), { status: WARNING_GATE_STATUS, headers: CORS })
    const wait = rateLimit(`comment:${user.id}`, COMMENT_RATE_MAX, COMMENT_RATE_WINDOW_MS)
    if (wait) {
      return NextResponse.json({ error: 'You’re commenting too fast. Try again in a few minutes.' }, { status: 429, headers: CORS })
    }
    const body = await req.json().catch(() => ({}))
    const comment = await createListingComment(id, user.id, body?.body)
    return NextResponse.json({ comment }, { status: 201, headers: CORS })
  } catch (err) {
    return commentErrorResponse(err, 'POST /api/local/listings/:id/comments:')
  }
}
