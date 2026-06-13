import { NextResponse } from 'next/server'
import { getListings, createListing } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Local-only API (no Supabase).
//   GET  /api/local/listings → JSON array (search: ?location=&guests=&checkIn=&checkOut=)
//   POST /api/local/listings → a host (or admin) creates a listing
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
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const listings = await getListings({
      location: url.searchParams.get('location') || undefined,
      guests: url.searchParams.get('guests') ? Number(url.searchParams.get('guests')) : undefined,
      checkIn: url.searchParams.get('checkIn') || undefined,
      checkOut: url.searchParams.get('checkOut') || undefined,
    })
    return NextResponse.json(listings, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/listings failed:', err)
    return NextResponse.json({ error: 'Failed to load listings', detail: String(err) }, { status: 500, headers: CORS })
  }
}

// A host creates a listing. Requires a signed-in user with role 'host' (or 'admin').
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    if (user.role !== 'host' && user.role !== 'admin') {
      return NextResponse.json({ error: 'Only hosts can add a listing. Register as a host first.' }, { status: 403, headers: CORS })
    }
    const b = await req.json()
    const listing = await createListing(user.id, {
      title: b.title,
      description: b.description,
      location: b.location,
      country: b.country,
      pricePerNight: Number(b.price_per_night ?? b.pricePerNight),
      bedrooms: b.bedrooms,
      beds: b.beds,
      bathrooms: b.bathrooms,
      maxGuests: b.max_guests ?? b.maxGuests,
      propertyType: b.property_type ?? b.propertyType,
      lat: b.lat,
      lng: b.lng,
      images: Array.isArray(b.images) ? b.images : undefined,
      amenities: Array.isArray(b.amenities) ? b.amenities : undefined,
    })
    return NextResponse.json(listing, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('POST /api/local/listings failed:', msg)
    const status = /required|positive|Invalid/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
