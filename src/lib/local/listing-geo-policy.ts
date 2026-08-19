// =============================================================================
// LISTING GEO POLICY — the map pin has to be where the listing says it is
// =============================================================================
// The create-listing form asks for the place twice: once in words (Location,
// Country, the curated Region chip, the Resort) and once as a pin the host drops
// on the map. Nothing compared the two. A host could choose Egypt → North Coast
// → Porto and then click the map in Germany, and the listing saved without a
// murmur: `createListing` wrote lat/lng through a bare `Number.isFinite` check
// (it did not even bound them to ±90/±180 the way the edit path did), and every
// surface that draws a listing on a map — explore, the listing page, the search
// map — then drew that Egyptian chalet in Bavaria.
//
// What this module decides is deliberately coarse: a **bounding box**, not a
// polygon and not a reverse-geocode. Two reasons. A reverse-geocode is a network
// call to Nominatim on every keystroke-worth of pin drag — rate-limited, offline
// on mobile, and fuzzy to compare against free text. And a box is explainable:
// an operator reading "outside North Coast" can check it on any map. The cost is
// that a box is generous at the corners, which is exactly the right trade for a
// check that WARNS rather than refuses (see below).
//
// The policy does not block. `checkListingPin` returns a problem; the host forms
// render it under the map and still let the host submit, and the API still saves
// — because a box drawn in this file must never be the reason a real property
// can't be listed. What it does instead is derive, at read time, the badge /ops
// shows on the listing while an operator decides whether to approve it. Nothing
// is stored: the same pin + country + region always produce the same verdict, so
// there is no column to migrate and no flag that can go stale after an edit.
//
// One exception is hard: a coordinate outside ±90/±180 is not a pin at all, and
// `assertCoord` in db.ts refuses it on both create and edit.
//
// Both projects carry this file byte-identical — the web one renders the warning
// under the host form's map and derives the /ops badge from it; the mobile API
// answers `pin_warning` with it on POST/PATCH, and refuses an impossible
// coordinate on create the way the edit path always did.
// `scripts/check-listing-geo-policy-parity.mjs` fails on drift. The mobile apps
// carry the same rule in their own languages —
// mobile/ios/Sources/ListingGeoPolicy.swift and
// mobile/android/…/com/quickin/app/ListingGeoPolicy.kt — and those two are kept
// in step BY HAND, no script: the boxes below are the contract between all four.
//
// Pure logic, no imports, so the same code runs in `db.ts`, in the host forms, in
// the /ops console and under `node --test` — see README → Testing. Mirrors
// listing-capacity-policy.ts: same `check` / `message` shape, so a reader who
// knows one knows this one.
// =============================================================================

/** A lat/lng rectangle, in degrees. `south`/`west` are the low corner. */
export interface GeoBox {
  south: number
  west: number
  north: number
  east: number
}

/**
 * Country boxes for the ten countries the host form offers.
 *
 * Padded outward by roughly a tenth of a degree from each country's real extent.
 * They are meant to answer "is this pin plausibly in the country the host chose",
 * not to trace a border — a listing a few kilometres off the coast (a marina, a
 * boat, a GPS drift on a beach compound) must not be flagged, while a pin on
 * another continent must be.
 */
export const COUNTRY_BOXES: Readonly<Record<string, GeoBox>> = {
  'Egypt': { south: 21.8, west: 24.5, north: 31.8, east: 37.1 },
  'Saudi Arabia': { south: 15.5, west: 34.3, north: 32.3, east: 55.8 },
  'United Arab Emirates': { south: 22.4, west: 51.4, north: 26.2, east: 56.6 },
  'Kuwait': { south: 28.4, west: 46.4, north: 30.2, east: 48.5 },
  'Qatar': { south: 24.4, west: 50.6, north: 26.3, east: 51.8 },
  'Bahrain': { south: 25.5, west: 50.3, north: 26.4, east: 50.9 },
  'Oman': { south: 16.5, west: 51.8, north: 26.5, east: 60.0 },
  'Jordan': { south: 29.1, west: 34.8, north: 33.5, east: 39.4 },
  'Lebanon': { south: 33.0, west: 35.0, north: 34.8, east: 36.7 },
  // Wide on purpose: the western box covers Western Sahara too rather than
  // flagging a host whose pin sits south of a disputed line.
  'Morocco': { south: 20.7, west: -17.3, north: 36.1, east: -0.9 },
}

/**
 * The four curated browse areas (listing-options.ts `REGIONS`), as boxes.
 *
 * Wider than the tourist's idea of each place, because the region is a browse
 * chip rather than an address: "North Coast" is the whole Alexandria → Marsa
 * Matrouh strip, and "Cairo" means Greater Cairo including Giza, Sheikh Zayed,
 * 6th of October and New Cairo — a listing in any of those is genuinely what a
 * guest filtering on "Cairo" is looking for.
 */
export const REGION_BOXES: Readonly<Record<string, GeoBox>> = {
  'North Coast': { south: 30.4, west: 24.9, north: 31.7, east: 30.4 },
  'Ain Sokhna': { south: 29.1, west: 32.0, north: 30.2, east: 32.9 },
  'El Gouna': { south: 26.8, west: 33.2, north: 27.9, east: 34.1 },
  'Cairo': { south: 29.5, west: 30.5, north: 30.5, east: 32.0 },
}

/** Why a pin was questioned. */
export type ListingPinProblemCode = 'outOfRange' | 'outsideCountry' | 'outsideRegion'

export interface ListingPinProblem {
  code: ListingPinProblemCode
  /**
   * The place the pin disagrees with — the country name for `outsideCountry`,
   * the region name for `outsideRegion`, empty for `outOfRange`. Callers put it
   * straight into a message without re-deriving which field was at fault.
   */
  scope: string
}

export interface ListingPinInput {
  lat?: unknown
  lng?: unknown
  country?: unknown
  region?: unknown
}

/** Country names hosts and older rows use that aren't the canonical spelling. */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  'uae': 'United Arab Emirates',
  'u.a.e.': 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
  'emirates': 'United Arab Emirates',
  'eg': 'Egypt',
  'egypt': 'Egypt',
  'arab republic of egypt': 'Egypt',
  'sa': 'Saudi Arabia',
  'ksa': 'Saudi Arabia',
  'saudi': 'Saudi Arabia',
  'saudi arabia': 'Saudi Arabia',
  'kw': 'Kuwait',
  'kuwait': 'Kuwait',
  'qa': 'Qatar',
  'qatar': 'Qatar',
  'bh': 'Bahrain',
  'bahrain': 'Bahrain',
  'om': 'Oman',
  'oman': 'Oman',
  'jo': 'Jordan',
  'jordan': 'Jordan',
  'lb': 'Lebanon',
  'lebanon': 'Lebanon',
  'ma': 'Morocco',
  'morocco': 'Morocco',
  'ae': 'United Arab Emirates',
}

/** Region spellings that mean one of the four curated areas. */
const REGION_ALIASES: Readonly<Record<string, string>> = {
  'north coast': 'North Coast',
  'northcoast': 'North Coast',
  'sahel': 'North Coast',
  'el sahel': 'North Coast',
  'ain sokhna': 'Ain Sokhna',
  'ein sokhna': 'Ain Sokhna',
  'sokhna': 'Ain Sokhna',
  'el gouna': 'El Gouna',
  'elgouna': 'El Gouna',
  'gouna': 'El Gouna',
  'cairo': 'Cairo',
  'greater cairo': 'Cairo',
}

/** Canonical country name for any casing/alias, or '' when we don't know it. */
export function canonicalCountry(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s) return ''
  if (COUNTRY_BOXES[s]) return s
  return COUNTRY_ALIASES[s.toLowerCase()] ?? ''
}

/** Canonical region name for any casing/alias, or '' when we don't know it. */
export function canonicalRegion(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s) return ''
  if (REGION_BOXES[s]) return s
  return REGION_ALIASES[s.toLowerCase()] ?? ''
}

/** A real coordinate pair, or null when either half is missing or unusable. */
export function readPin(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (lat === undefined || lat === null || lat === '') return null
  if (lng === undefined || lng === null || lng === '') return null
  const la = Number(lat)
  const ln = Number(lng)
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null
  return { lat: la, lng: ln }
}

/** Whether a coordinate pair falls inside [box] (inclusive on every edge). */
export function isInsideBox(lat: number, lng: number, box: GeoBox): boolean {
  return lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east
}

/**
 * The one question this module answers: does the pin agree with the words?
 *
 * Returns `null` — no complaint — whenever we cannot honestly judge:
 *   • no pin at all (it is an optional field; the listing is saved without one),
 *   • a country we have no box for (a host typed one, or an older row),
 *   • a region we have no box for.
 * Silence is the right answer there. A warning a host cannot act on is worse
 * than no warning, and this text is shown next to a map they just used.
 *
 * The order matters: an impossible coordinate is reported as itself rather than
 * as "outside Egypt", and the country is judged before the region so a pin in
 * Germany on a North Coast listing names the bigger, more obvious mistake.
 */
export function checkListingPin(input: ListingPinInput): ListingPinProblem | null {
  const pin = readPin(input.lat, input.lng)
  if (!pin) return null
  if (Math.abs(pin.lat) > 90 || Math.abs(pin.lng) > 180) return { code: 'outOfRange', scope: '' }

  const country = canonicalCountry(input.country)
  const countryBox = country ? COUNTRY_BOXES[country] : undefined
  if (countryBox && !isInsideBox(pin.lat, pin.lng, countryBox)) {
    return { code: 'outsideCountry', scope: country }
  }

  const region = canonicalRegion(input.region)
  const regionBox = region ? REGION_BOXES[region] : undefined
  if (regionBox && !isInsideBox(pin.lat, pin.lng, regionBox)) {
    return { code: 'outsideRegion', scope: region }
  }

  return null
}

/** True when the pin disagrees with the listing's own location fields. */
export function isListingPinMismatch(input: ListingPinInput): boolean {
  return checkListingPin(input) !== null
}

/**
 * English text for a problem — the /ops badge tooltip and the fallback the API
 * uses. The host forms translate the `code` through next-intl instead, so the
 * warning under the map is in the host's own language.
 */
export function listingPinProblemMessage(problem: ListingPinProblem | null): string {
  if (!problem) return ''
  switch (problem.code) {
    case 'outOfRange':
      return 'The map pin is not a real coordinate. Drop it again on the map.'
    case 'outsideCountry':
      return `The map pin is outside ${problem.scope}. Move the pin to the property, or change the country.`
    case 'outsideRegion':
      return `The map pin is outside ${problem.scope}. Move the pin to the property, or change the area.`
    default:
      return ''
  }
}

/** Short label for the /ops listing card badge, or '' when the pin is fine. */
export function listingPinBadgeLabel(input: ListingPinInput): string {
  const problem = checkListingPin(input)
  if (!problem) return ''
  return problem.code === 'outOfRange' ? 'Pin: invalid' : `Pin outside ${problem.scope}`
}
