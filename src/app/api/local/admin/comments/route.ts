import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { adminListComments } from '@/lib/local/listing-comments'

// Staff view of public listing comments (/ops → Comments). Module: moderation.
//   GET /api/local/admin/comments?scope=visible|hidden|removed|all&q=&listingId=&userId=
//     → { comments: [{ id, listing_id, listing_title, user_id, author_name, author_email,
//          author_status, body, created_at, host_reply, host_replied_at,
//          deleted_at, deleted_by, delete_reason, state }] }
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'moderation')
  if ('error' in gate) return gate.error
  try {
    const p = new URL(req.url).searchParams
    const comments = await adminListComments({
      scope: p.get('scope'),
      q: p.get('q'),
      listingId: p.get('listingId'),
      userId: p.get('userId'),
    })
    return NextResponse.json({ comments }, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/admin/comments:', err)
    return NextResponse.json({ error: 'Failed to load comments' }, { status: 500, headers: CORS })
  }
}
