import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { hasOpenAIKey, createCompletion } from '@/lib/local/ai'

// POST /api/local/ai/listing-description (Bearer)
//   { title, location, region, propertyType, bedrooms, maxGuests, amenities[], notes }
//   → { description }
// AI-writes a polished, guest-facing listing description. Falls back to a
// template if OPENAI_API_KEY isn't configured, so the feature always works.
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
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

function fallbackDescription(b: Record<string, unknown>): string {
  const title = String(b.title ?? 'This stay')
  const place = [b.location, b.region].filter(Boolean).join(', ')
  const type = String(b.propertyType ?? 'place')
  const amenities = Array.isArray(b.amenities) ? (b.amenities as string[]).slice(0, 6) : []
  const guests = b.maxGuests ? `Sleeps up to ${b.maxGuests} guests. ` : ''
  const amenityLine = amenities.length ? `Enjoy ${amenities.join(', ')}. ` : ''
  return `${title} is a welcoming ${type.toLowerCase()}${place ? ` in ${place}` : ''}. ${guests}${amenityLine}` +
    `Thoughtfully prepared for a relaxing getaway, it's an ideal base to unwind and explore the area. Book your stay and make it yours.`
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))

    if (!hasOpenAIKey()) {
      return NextResponse.json({ description: fallbackDescription(b), ai: false }, { headers: CORS })
    }

    const facts = [
      b.title && `Title: ${b.title}`,
      (b.location || b.region) && `Location: ${[b.location, b.region].filter(Boolean).join(', ')}`,
      b.propertyType && `Type: ${b.propertyType}`,
      b.bedrooms && `Bedrooms: ${b.bedrooms}`,
      b.maxGuests && `Sleeps: ${b.maxGuests}`,
      Array.isArray(b.amenities) && b.amenities.length && `Amenities: ${(b.amenities as string[]).join(', ')}`,
      b.notes && `Host notes: ${b.notes}`,
    ].filter(Boolean).join('\n')

    const description = await createCompletion(
      [
        {
          role: 'system',
          content:
            'You write warm, vivid, honest vacation-rental listing descriptions for QuickIn (boutique stays in Egypt). ' +
            'Write 2 short paragraphs (~90-130 words total), guest-facing, second person, evocative but not exaggerated. ' +
            'Do not invent amenities, prices, or exact addresses. Match the language of the input (Arabic or English). Return only the description text.',
        },
        { role: 'user', content: `Write a listing description from these details:\n${facts}` },
      ],
      { temperature: 0.8, maxTokens: 400 }
    )
    return NextResponse.json({ description, ai: true }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to write description', detail: String(err) }, { status: 500, headers: CORS })
  }
}
