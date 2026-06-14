import { createTravelChatStream, hasOpenAIKey, type ChatMessage } from '@/lib/local/ai'

// POST /api/local/ai/chat — the QuickIn AI travel concierge ("where to go in
// Egypt?"). Body: { messages: [{ role: 'user' | 'assistant', content }] }.
// Streams the reply back as Server-Sent Events:
//   data: {"delta":"..."}\n\n   per token
//   data: [DONE]\n\n            at the end
// The OPENAI_API_KEY lives only on the server (see src/lib/local/ai.ts).
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function POST(req: Request) {
  if (!hasOpenAIKey()) {
    return new Response(
      JSON.stringify({ error: 'AI is not configured. Set OPENAI_API_KEY on the server.' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...CORS } }
    )
  }

  let messages: ChatMessage[] = []
  try {
    const body = await req.json()
    messages = Array.isArray(body?.messages) ? body.messages : []
  } catch {
    messages = []
  }
  if (!messages.some((m) => m?.role === 'user' && typeof m?.content === 'string')) {
    return new Response(
      JSON.stringify({ error: 'messages must include at least one user turn' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
    )
  }

  try {
    const stream = await createTravelChatStream(messages)
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disable proxy buffering so tokens flush immediately.
        'X-Accel-Buffering': 'no',
        ...CORS,
      },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
}
