import { NextResponse } from 'next/server'
import { getPlaceSuggestions } from '@/lib/local/db'

// GET /api/local/places?q=  → { places: string[] }  (place autocomplete for search)
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET,OPTIONS' },
  })
}

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams.get('q') || ''
    const places = await getPlaceSuggestions(q)
    return NextResponse.json({ places }, { headers: CORS })
  } catch {
    return NextResponse.json({ places: [] }, { headers: CORS })
  }
}
