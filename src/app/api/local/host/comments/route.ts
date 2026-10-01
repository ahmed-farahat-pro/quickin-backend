import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getHostComments } from '@/lib/local/listing-comments'

// The host's "Guest questions": comments across every listing they host,
// unanswered first.
//   GET /api/local/host/comments → { comments: [...with listing_title, listing_image], unanswered }
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    return NextResponse.json(await getHostComments(user.id), { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/host/comments:', err)
    return NextResponse.json({ error: 'Failed to load comments' }, { status: 500, headers: CORS })
  }
}
