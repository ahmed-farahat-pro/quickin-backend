import { NextResponse } from 'next/server'
import { getUserNotifications, getUnreadCount } from '@/lib/local/notifications'
import { getUserFromRequest } from '@/lib/local/auth'

// GET /api/local/notifications → { notifications, unreadCount } for the signed-in user.
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
    const [notifications, unreadCount] = await Promise.all([
      getUserNotifications(user.id),
      getUnreadCount(user.id),
    ])
    return NextResponse.json({ notifications, unreadCount }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load notifications', detail: String(err) }, { status: 500, headers: CORS })
  }
}
