import { NextResponse } from 'next/server'
import { getListings } from '@/lib/local/db'

// Local-only API (no Supabase). GET /api/local/listings → JSON array.
// Supports search: ?location=&guests=&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
// Consumed by the /explore web page and the iOS + Android apps.
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const listings = await getListings({
      location: url.searchParams.get('location') || undefined,
      guests: url.searchParams.get('guests') ? Number(url.searchParams.get('guests')) : undefined,
      checkIn: url.searchParams.get('checkIn') || undefined,
      checkOut: url.searchParams.get('checkOut') || undefined,
    })
    return NextResponse.json(listings, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('GET /api/local/listings failed:', err)
    return NextResponse.json(
      { error: 'Failed to load listings', detail: String(err) },
      { status: 500 }
    )
  }
}
