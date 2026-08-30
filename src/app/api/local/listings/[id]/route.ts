import { NextResponse } from 'next/server'
import {
  getListingById,
  updateListingDetails,
  isListingInputError,
  isListingHost,
  type ListingPatch,
} from '@/lib/local/db'
import { checkListingPin, listingPinProblemMessage } from '@/lib/local/listing-geo-policy'
import { getUserFromRequest } from '@/lib/local/auth'

// GET   /api/local/listings/:id → a single listing (no Supabase). `?asHost=1` asks
//        for the HOST projection — raw prices, before the platform commission —
//        and is honoured only when the caller really is this listing's host.
// PATCH /api/local/listings/:id → the listing's HOST edits any part of it:
//        details (title, description, location, country, region, lat/lng, property_type,
//        max_guests, bedrooms, beds, bathrooms, amenities), pricing (price_per_night,
//        weekend_price, weekend_days, monthly_prices, weekly/monthly_discount), cancellation_policy,
//        ownership_doc, and the photo set (images).
//        Only the keys present in the body are written. EVERY edit sends the listing
//        back to the admin queue (approval_status='pending', is_published=false) — the
//        response carries the new approval_status so clients can show "under review"
//        without a refetch. Which fields trigger that lives in ONE place:
//        REVIEW_TRIGGERING_FIELDS in src/lib/local/db.ts.
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
      'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

// Body key(s) → patch field. Both the API's snake_case and the camelCase the
// mobile encoders emit are accepted, exactly like POST /api/local/listings.
const FIELD_KEYS: Record<keyof ListingPatch, string[]> = {
  title: ['title'],
  description: ['description'],
  location: ['location'],
  country: ['country'],
  region: ['region'],
  // The host picks a catalog resort, or types one via "Other".
  resort_id: ['resort_id', 'resortId'],
  resort_name: ['resort_name', 'resortName'],
  lat: ['lat', 'latitude'],
  lng: ['lng', 'longitude'],
  property_type: ['property_type', 'propertyType'],
  max_guests: ['max_guests', 'maxGuests'],
  bedrooms: ['bedrooms'],
  beds: ['beds'],
  bathrooms: ['bathrooms'],
  amenities: ['amenities'],
  ownership_doc: ['ownership_doc', 'ownershipDoc'],
  images: ['images', 'photos'],
  price_per_night: ['price_per_night', 'pricePerNight'],
  weekend_price: ['weekend_price', 'weekendPrice'],
  weekend_days: ['weekend_days', 'weekendDays'],
  monthly_prices: ['monthly_prices', 'monthlyPrices'],
  weekly_discount: ['weekly_discount', 'weeklyDiscount'],
  monthly_discount: ['monthly_discount', 'monthlyDiscount'],
  cancellation_policy: ['cancellation_policy', 'cancellationPolicy'],
}

/** Pick out only the fields the caller actually sent — an omitted key keeps its
 *  current value. A blank ownership_doc is treated as "not sent" (the previous
 *  route ignored it too, and the iOS client omits it when empty). */
function readPatch(body: Record<string, unknown>): ListingPatch {
  const patch: ListingPatch = {}
  for (const [field, keys] of Object.entries(FIELD_KEYS) as [keyof ListingPatch, string[]][]) {
    const key = keys.find((k) => body[k] !== undefined)
    if (key === undefined) continue
    const value = body[key]
    if (field === 'ownership_doc' && typeof value === 'string' && !value.trim()) continue
    patch[field] = value
  }
  return patch
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    // The host's own edit form loads these prices and saves them straight back,
    // so it has to see the RAW price the host set — handed the guest projection
    // it re-saves a commission-inclusive number as the host's price, and every
    // edit marks the listing up again. This route ignored ?asHost entirely when
    // the two backends were merged, and /host/:id/edit has been asking for it
    // ever since.
    //
    // The flag alone is not enough to grant it: being signed in does not entitle
    // anyone to another host's raw prices, so ownership is checked, exactly as
    // the calendar route does it. A non-owner passing ?asHost=1 simply gets the
    // guest projection they would have got anyway.
    //
    // `asHost=0` means no. Presence alone would make it a yes, and a caller
    // turning the flag off by setting it to 0 is the obvious way to write that.
    const asHostParam = new URL(req.url).searchParams.get('asHost')
    const wantsHost = asHostParam !== null && asHostParam !== '0' && asHostParam !== 'false'
    // Resolved at most once, and only when something actually needs to know who
    // is asking — the ?asHost projection, or the owner check on a hidden listing.
    // A plain guest read of a published listing still costs no auth round trip.
    let cachedViewer: string | null | undefined
    const viewerId = async () => {
      if (cachedViewer === undefined) {
        cachedViewer = (await getUserFromRequest(req).catch(() => null))?.id ?? null
      }
      return cachedViewer
    }
    const asHost = wantsHost && (await isListingHost(id, await viewerId()))
    const listing = await getListingById(id, { asHost })
    if (!listing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS })
    }
    // An unpublished listing does not exist as far as the public is concerned.
    // Search has always dropped it and createBooking has always refused it, but
    // this route served it to anyone holding the id — so a listing a host had
    // taken down, or that an operator had, still rendered in full from a deep
    // link or a shared URL. Its OWNER may still open it (the host dashboard's
    // View button lands here), which is why ownership is checked even without
    // ?asHost: that flag chooses the price projection, not who may look.
    if (!listing.is_published && !asHost && !(await isListingHost(id, await viewerId()))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS })
    }
    return NextResponse.json(listing, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/listings/[id] failed:', err)
    return NextResponse.json(
      { error: 'Failed to load listing', detail: String(err) },
      { status: 500, headers: CORS }
    )
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const patch = readPatch(b as Record<string, unknown>)
    if (!Object.keys(patch).length) {
      return NextResponse.json(
        { error: `Nothing to update — send any of: ${Object.keys(FIELD_KEYS).join(', ')}` },
        { status: 400, headers: CORS }
      )
    }
    // Ownership is enforced inside the SQL (host_id = the signed-in user), so a
    // listing that isn't theirs simply matches no row.
    const updated = await updateListingDetails(id, user.id, patch)
    if (!updated) {
      return NextResponse.json({ error: 'Only the listing host can edit this listing' }, { status: 403, headers: CORS })
    }
    // Same non-blocking pin check the create route answers with — a pin can be
    // dragged into the wrong country from the editor too. See listing-geo-policy.ts.
    const pinProblem = checkListingPin({
      lat: updated.lat,
      lng: updated.lng,
      country: updated.country,
      region: updated.region,
    })
    return NextResponse.json(
      {
        ...updated,
        pin_warning: pinProblem
          ? { code: pinProblem.code, scope: pinProblem.scope, message: listingPinProblemMessage(pinProblem) }
          : null,
      },
      { headers: CORS },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('PATCH /api/local/listings/[id] failed:', msg)
    // Anything a host can fix in the form answers 400; everything else is a real 500.
    return NextResponse.json({ error: msg }, { status: isListingInputError(err) ? 400 : 500, headers: CORS })
  }
}
