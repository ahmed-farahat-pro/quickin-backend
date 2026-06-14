// QuickIn AI travel concierge — OpenAI (ChatGPT) streaming, dependency-free.
//
// Talks to the OpenAI Chat Completions API over `fetch` with `stream: true`,
// parses the upstream Server-Sent-Events, and re-emits a SIMPLE SSE stream the
// web / iOS / Android clients consume token-by-token:
//
//     data: {"delta":"...text..."}\n\n      (repeated per token)
//     data: [DONE]\n\n                       (once, at the end)
//     data: {"error":"..."}\n\n              (on failure, then close)
//
// The OPENAI_API_KEY never leaves the server. Set it (and optionally
// OPENAI_MODEL, default gpt-4o-mini) in the backend environment.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// The concierge persona: a "where should I go in Egypt?" companion that leans on
// QuickIn's regions and steers users toward booking a stay.
const SYSTEM_PROMPT = `You are "QuickIn Concierge", a warm, expert travel guide for trips inside Egypt, built into the QuickIn vacation-rental app. Your job is to help travelers decide WHERE TO GO in Egypt and plan the trip.

Egypt destinations and their vibes:
- North Coast (Sahel): summer beach season (Jun–Sep), turquoise water, upscale, lively nightlife around Marassi/Hacienda.
- El Gouna: year-round lagoon town near Hurghada, watersports, kitesurfing, calm and walkable.
- Ain Sokhna: closest Red Sea beach to Cairo (~2h), easy weekend getaway.
- Hurghada & Sahl Hasheesh: diving, resorts, year-round sun.
- Dahab: laid-back, budget-friendly, world-class diving (Blue Hole), Sinai mountains.
- Sharm El Sheikh / Ras Mohammed: reefs, resorts, diving.
- Marsa Alam: pristine reefs, dolphins, quieter.
- Cairo & Giza: pyramids, museums, history, food.
- Luxor & Aswan: ancient temples, Nile cruises (best Oct–Apr).
- Siwa Oasis: desert, salt lakes, off-grid calm.

Guidelines:
- Be concise and scannable. Lead with a direct recommendation, then 2–4 short reasons.
- When the request is vague, ask ONE quick clarifying question (dates, budget, vibe: party/calm/family/diving, who's traveling).
- Tailor by season, travel time from Cairo, and vibe.
- Naturally suggest booking a stay on QuickIn (e.g. "you can find stays in El Gouna on QuickIn").
- Reply in the user's language — Arabic or English — matching their latest message.
- Stay on Egypt travel; if asked something unrelated, gently steer back.
- Never invent specific prices or property names; speak in general terms.`

/** Whether the server is configured to talk to OpenAI. */
export function hasOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim()
}

/**
 * Open a streamed chat completion for the given conversation and return a
 * ReadableStream in OUR own SSE format (see file header). Throws if the key is
 * missing or the upstream request fails to start.
 */
export async function createTravelChatStream(
  messages: ChatMessage[]
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini'

  // Keep only valid user/assistant turns, capped to the last 20 so the context
  // (and cost) stays bounded; prepend the system persona.
  const history = messages
    .filter(
      (m) => m && typeof m.content === 'string' && m.content.trim().length > 0 &&
        (m.role === 'user' || m.role === 'assistant')
    )
    .slice(-20)

  const upstream = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.7,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    }),
  })

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    throw new Error(`OpenAI request failed (${upstream.status}): ${detail.slice(0, 300)}`)
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = upstream.body.getReader()
  let buffer = ''

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        // Upstream SSE lines are newline-delimited; keep the trailing partial.
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') continue // we emit our own [DONE] at stream end
          try {
            const json = JSON.parse(data)
            const delta = json?.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length > 0) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`))
            }
          } catch {
            // Ignore keep-alive / unparseable lines.
          }
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`))
        controller.close()
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })
}
