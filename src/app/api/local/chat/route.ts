import { NextResponse } from 'next/server'
import {
  getOrCreateConversation,
  listConversations,
  listChatMessages,
  postChatMessage,
} from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Pre-booking chat (guest ⇄ host). Polled by the web + mobile clients.
//   GET  /api/local/chat                        → { conversations }
//   GET  /api/local/chat?conversationId=…       → { messages }
//   POST /api/local/chat { listingId }          → { conversationId }  (open/reuse a thread)
//   POST /api/local/chat { conversationId, body } → { message }        (send)
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' },
  })
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const conversationId = new URL(req.url).searchParams.get('conversationId')
    if (conversationId) {
      return NextResponse.json({ messages: await listChatMessages(user.id, conversationId) }, { headers: CORS })
    }
    return NextResponse.json({ conversations: await listConversations(user.id) }, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /not found|Invalid/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: CORS })

    if (body.conversationId && typeof body.body === 'string') {
      const message = await postChatMessage(user.id, String(body.conversationId), String(body.body))
      return NextResponse.json({ message }, { status: 201, headers: CORS })
    }
    if (body.listingId) {
      const convo = await getOrCreateConversation(user.id, String(body.listingId))
      return NextResponse.json({ conversationId: convo.id, listingTitle: convo.listing_title }, { status: 201, headers: CORS })
    }
    return NextResponse.json({ error: 'Nothing to do' }, { status: 400, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /not found|Invalid|empty|own listing|no host|hidden|number/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
