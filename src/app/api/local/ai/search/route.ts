import { NextResponse } from 'next/server'
import { getListings, REGIONS, type SearchFilters } from '@/lib/local/db'
import { hasOpenAIKey, createCompletion } from '@/lib/local/ai'

// POST /api/local/ai/search { query } → { filters, listings, ai }
// Turns a natural-language query into structured search filters via AI, then
// runs the normal listings search. Falls back to plain free-text search if
// OPENAI_API_KEY isn't set or parsing fails.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

const AMENITIES = ['WiFi', 'Pool', 'Kitchen', 'Air conditioning', 'Free parking', 'Washer', 'TV', 'Heating', 'Workspace', 'Gym', 'Beach access', 'Pets allowed', 'Hot tub', 'BBQ grill', 'Breakfast']
const PROPERTY_TYPES = ['Apartment', 'Chalet', 'House', 'Villa']

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

function clean(filters: SearchFilters): SearchFilters {
  const out: SearchFilters = {}
  if (typeof filters.q === 'string' && filters.q.trim()) out.q = filters.q.trim()
  if (typeof filters.region === 'string' && (REGIONS as readonly string[]).includes(filters.region)) out.region = filters.region
  if (Number.isFinite(filters.guests as number) && (filters.guests as number) > 0) out.guests = Math.floor(filters.guests as number)
  if (Number.isFinite(filters.minPrice as number) && (filters.minPrice as number) >= 0) out.minPrice = filters.minPrice
  if (Number.isFinite(filters.maxPrice as number) && (filters.maxPrice as number) > 0) out.maxPrice = filters.maxPrice
  if (typeof filters.propertyType === 'string' && PROPERTY_TYPES.includes(filters.propertyType)) out.propertyType = filters.propertyType
  if (Array.isArray(filters.amenities)) {
    const a = filters.amenities.filter((x) => AMENITIES.includes(x))
    if (a.length) out.amenities = a
  }
  return out
}

export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}))
    const query = String(b.query ?? b.q ?? '').trim()
    if (!query) return NextResponse.json({ filters: {}, listings: await getListings({}), ai: false }, { headers: CORS })

    // No key → plain free-text search.
    if (!hasOpenAIKey()) {
      const filters = { q: query }
      return NextResponse.json({ filters, listings: await getListings(filters), ai: false }, { headers: CORS })
    }

    let filters: SearchFilters = { q: query }
    try {
      const raw = await createCompletion(
        [
          {
            role: 'system',
            content:
              'You convert a traveler\'s natural-language request into JSON search filters for QuickIn (vacation rentals in Egypt). ' +
              `Return ONLY a JSON object with any of these keys: q (string, leftover free text or place name), region (one of ${REGIONS.join(', ')}), ` +
              `guests (int), minPrice (int, EGP/night), maxPrice (int, EGP/night), propertyType (one of ${PROPERTY_TYPES.join(', ')}), ` +
              `amenities (array from: ${AMENITIES.join(', ')}). Omit keys you are unsure about. Map synonyms (e.g. "beachfront"→Beach access, "wifi"→WiFi).`,
          },
          { role: 'user', content: query },
        ],
        { json: true, temperature: 0.2, maxTokens: 250 }
      )
      const parsed = JSON.parse(raw)
      filters = clean(parsed)
      if (Object.keys(filters).length === 0) filters = { q: query }
    } catch {
      filters = { q: query } // fall back to free-text on any AI/parse failure
    }

    const listings = await getListings(filters)
    return NextResponse.json({ filters, listings, ai: true }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Search failed', detail: String(err) }, { status: 500, headers: CORS })
  }
}
