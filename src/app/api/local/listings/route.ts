import { NextResponse } from 'next/server'
import { getListings, createListing, getListingGateState } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'
import { canPublishListing } from '@/lib/local/host-verification-core'

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
    const sp = new URL(req.url).searchParams
    const num = (k: string) => (sp.get(k) ? Number(sp.get(k)) : undefined)
    const amenities = sp.get('amenities')
      ? sp.get('amenities')!.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined
    // "Search this area": bbox=minLng,minLat,maxLng,maxLat (GeoJSON west,south,east,north order).
    let bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number } | undefined
    if (sp.get('bbox')) {
      const parts = sp.get('bbox')!.split(',').map((s) => Number(s.trim()))
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        const [minLng, minLat, maxLng, maxLat] = parts
        bbox = { minLat, minLng, maxLat, maxLng }
      }
    }
    const listings = await getListings({
      // `q` is the new free-text param; `location` is kept for back-compat.
      q: sp.get('q') || undefined,
      location: sp.get('location') || undefined,
      region: sp.get('region') || undefined,
      host: sp.get('host') || undefined,
      guests: num('guests'),
      checkIn: sp.get('checkIn') || undefined,
      checkOut: sp.get('checkOut') || undefined,
      minPrice: num('minPrice'),
      maxPrice: num('maxPrice'),
      propertyType: sp.get('propertyType') || undefined,
      amenities,
      bbox,
      sort: (sp.get('sort') as 'recommended' | 'price_asc' | 'price_desc' | 'newest' | null) || undefined,
    })
    return NextResponse.json(listings, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/listings failed:', err)
    return NextResponse.json({ error: 'Failed to load listings', detail: String(err) }, { status: 500, headers: CORS })
  }
}

// A host creates a listing. Requires an approved host whose identity an admin has
// verified — see host-verification-core.ts. The refusal carries a `code` so the
// apps can show the right next step ("verify now" vs "we're reviewing it" vs
// "here's why it was rejected") instead of parsing the message.
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    // The hardcoded admin token has no DB row, so it can't be looked up; treat it
    // as staff and let it through, as it is elsewhere.
    const gate =
      user.role === 'admin'
        ? canPublishListing({ isHost: true, verificationStatus: 'verified', isStaff: true })
        : canPublishListing(await getListingGateState(user.id))
    if (!gate.allowed) {
      return NextResponse.json({ error: gate.message, code: gate.code }, { status: 403, headers: CORS })
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
      region: b.region,
      resortId: b.resort_id ?? b.resortId,
      resortName: b.resort_name ?? b.resortName,
      lat: b.lat,
      lng: b.lng,
      images: Array.isArray(b.images) ? b.images : undefined,
      amenities: Array.isArray(b.amenities) ? b.amenities : undefined,
      cancellationPolicy: b.cancellation_policy ?? b.cancellationPolicy,
      ownershipDoc: b.ownership_doc ?? b.ownershipDoc,
      weeklyDiscount: b.weekly_discount ?? b.weeklyDiscount,
      monthlyDiscount: b.monthly_discount ?? b.monthlyDiscount,
      weekendPrice: b.weekend_price ?? b.weekendPrice,
      monthlyPrices: b.monthly_prices ?? b.monthlyPrices,
    })
    return NextResponse.json(listing, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('POST /api/local/listings failed:', msg)
    const status = /required|positive|Invalid/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
