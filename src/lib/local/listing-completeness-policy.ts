// =============================================================================
// LISTING COMPLETENESS POLICY — what a listing has to say before it is a listing
// =============================================================================
// Create-listing required a **title and a price. That was all.** A host could
// open /host/new, type a name and a number, press Create, and the row landed in
// `listings` with a NULL description, no address, no map pin, no curated area
// and not one photo — and nothing on the form said those fields mattered, since
// only the title carried a `required`. The result is a listing a guest cannot
// evaluate (no description), cannot find (no region to filter by), cannot see
// (no photos) and cannot place (no pin, so it is absent from the /explore map
// that the whole browse experience is built on).
//
// This module is the answer to that. It decides, in one place, whether a listing
// says enough to be shown to anyone, and every door that creates one runs it:
// `createListing`, the /host/new form, and the create wizards in both mobile
// apps (which had reached the same conclusion field by field — both already
// required the region and the pin, neither required a description or a photo).
//
// Two deliberate limits, both load-bearing:
//
//   1. **Both doors, judged differently.** `createListing` judges the whole
//      listing: everything must be answered. The edit door judges only the
//      fields the patch actually touches (`checkListingEdit`), because a patch
//      is partial by nature — the mobile apps send `{ ownership_doc }` on its
//      own, and photos travel through their own routes. That is enough to close
//      the hole that matters: a listing can no longer be created complete and
//      then edited back down, since clearing a required field IS touching it.
//      What it deliberately does not do is hold a host's price change hostage to
//      a description their listing never had — the rows that predate this rule
//      stay editable in the parts they are actually editing.
//   2. **Presence, not quality.** A description has to be a description — real
//      letters, enough of them to be a sentence — but this module does not
//      judge whether it is a *good* description. That is what the admin review
//      in /ops is for; every new listing lands there as `pending` regardless.
//
// The resort is deliberately NOT required. A standalone villa belongs to no
// compound, and making the field mandatory would push those hosts through the
// "Other" free-text box and fill the moderation queue with names that are not
// resorts. The **region** is what guests actually filter on, so that is the one
// that has to be answered — which is also the rule both mobile wizards already
// enforced, so the three clients now agree instead of nearly agreeing.
//
// Pure logic, no imports, so the same code runs in `db.ts`, in the host form and
// under `node --test` — see README → Testing. Callers import the core, never the
// reverse. Mirrors listing-capacity-policy.ts and listing-title-policy.ts: same
// problem shape, same `check` / `message` / `validate` trio, so a reader who
// knows one knows this one.
// =============================================================================

/**
 * The fields a new listing must answer, in the order the host meets them on the
 * create form. `checkListingCompleteness` reports the first unanswered one, so
 * that order is what decides which field a host is sent back to — the topmost
 * empty one, rather than whichever the code happened to look at first.
 */
export const LISTING_REQUIRED_FIELDS = [
  'description',
  'location',
  'region',
  'pin',
  'propertyType',
  'photos',
] as const

export type ListingRequiredField = (typeof LISTING_REQUIRED_FIELDS)[number]

/**
 * Enough letters to be a description rather than a shrug.
 *
 * Twenty is what the dashboard wizard's zod schema already asked for
 * (`description: z.string().min(20)`), so this is the platform's existing answer
 * to the same question rather than a new number invented here. It counts
 * **letters**, not characters, for the reason listing-title-policy.ts counts
 * them: `....................` is twenty characters and no description at all.
 */
export const MIN_DESCRIPTION_LETTERS = 20

/** Enough letters to be a place name. `12` is a door number, not an address. */
export const MIN_LOCATION_LETTERS = 3

/** A listing with no photo is a listing nobody clicks. One is the floor. */
export const MIN_LISTING_PHOTOS = 1

/**
 * Why a field was refused.
 *
 * Structured like `ListingCapacityProblem` and for the same reason: the API
 * echoes the code and the field so a client can localize the reason without
 * re-deciding it. `min` is the floor that was missed, carried along so a message
 * can name it without importing the constant.
 */
export type ListingCompletenessProblemCode = 'required' | 'letters' | 'tooShort' | 'tooFew'

export interface ListingCompletenessProblem {
  code: ListingCompletenessProblemCode
  field: ListingRequiredField
  /** Present on `tooShort` (letters needed) and `tooFew` (photos needed). */
  min?: number
}

/** Everything the policy looks at. Every field optional — an omitted one is
 *  exactly the case this module exists to catch, so it must be expressible. */
export interface ListingCompletenessInput {
  description?: unknown
  location?: unknown
  region?: unknown
  /** A chosen resort answers the area question on its own — see
   *  `checkListingArea`. Both aliases the clients send are accepted. */
  resort_id?: unknown
  resort_name?: unknown
  lat?: unknown
  lng?: unknown
  property_type?: unknown
  images?: unknown
}

// A letter in any script — `\p{L}` covers Arabic, Latin, Cyrillic and the CJK
// ideographs alike, which is the whole point of using it over /[A-Za-z]/.
const HAS_LETTER = /\p{L}/u

// Invisible characters people paste in without meaning to: the soft hyphen, the
// Mongolian vowel separator, the zero-width spaces and bidi marks, the BOM. They
// survive a `.trim()` and render as nothing, so a field holding only them would
// otherwise read as filled in. Same set listing-title-policy.ts strips, repeated
// here rather than imported because this module has no imports by design.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu

/** Invisibles dropped, every run of whitespace collapsed to one space, ends
 *  trimmed — the same normalization the title takes, for the same reasons. */
export function normalizeListingText(value: unknown): string {
  return String(value ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** How many letters the text actually contains, in any script. */
function letterCount(text: string): number {
  let count = 0
  for (const ch of text) {
    if (HAS_LETTER.test(ch)) count++
  }
  return count
}

/**
 * The shared shape of the two free-text checks. Order matters and is the same
 * one the title policy uses: `letters` is reported before `tooShort`, so a box
 * holding `@@@@@@@@@@@@@@@@@@@@` is told it needs words rather than being sent
 * back to add a twenty-first `@`.
 */
function checkText(
  value: unknown,
  field: ListingRequiredField,
  min: number
): ListingCompletenessProblem | null {
  const text = normalizeListingText(value)
  if (!text) return { code: 'required', field }
  const letters = letterCount(text)
  if (letters === 0) return { code: 'letters', field }
  if (letters < min) return { code: 'tooShort', field, min }
  return null
}

/** The listing's own words. Missing, symbol-only, or too short to say anything. */
export function checkListingDescription(value: unknown): ListingCompletenessProblem | null {
  return checkText(value, 'description', MIN_DESCRIPTION_LETTERS)
}

/** The address in words — what the listing page prints under the title. */
export function checkListingAddress(value: unknown): ListingCompletenessProblem | null {
  return checkText(value, 'location', MIN_LOCATION_LETTERS)
}

/**
 * The curated browse area — the chips guests filter by.
 *
 * A **resort satisfies this on its own**. The two selects are not independent:
 * `resolveResortSelection` derives the region from the resort a host picks, and
 * the create form narrows the resort list to the chosen region. Asking for the
 * region separately would refuse a listing that names its compound and let the
 * server fill the region in a line later — a rule that contradicts the code
 * right next to it.
 *
 * Whether the value is one the catalog knows is not this module's business —
 * `normalizeRegion` and `assertResortName` in db.ts refuse those; the only
 * question here is whether the host said where the place is at all.
 */
export function checkListingArea(input: ListingCompletenessInput): ListingCompletenessProblem | null {
  const answered =
    normalizeListingText(input.region) ||
    normalizeListingText(input.resort_id) ||
    normalizeListingText(input.resort_name)
  return answered ? null : { code: 'required', field: 'region' }
}

/**
 * The map pin. Both halves or neither — a listing with a latitude and no
 * longitude is not half-placed, it is unplaced, and the range check that
 * follows in `assertCoord` would happily accept the lone number.
 */
export function checkListingPinPresence(lat: unknown, lng: unknown): ListingCompletenessProblem | null {
  const present = (v: unknown) =>
    v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))
  return present(lat) && present(lng) ? null : { code: 'required', field: 'pin' }
}

/** Apartment, chalet, villa… Whether the value is one the catalog knows is
 *  `normalizePropertyType`'s call; this only asks that one was chosen. */
export function checkListingPropertyType(value: unknown): ListingCompletenessProblem | null {
  return normalizeListingText(value) ? null : { code: 'required', field: 'propertyType' }
}

/**
 * The photos. Counts what is actually there — a non-array (the shape a client
 * that forgot the field sends) is zero photos, not an exemption.
 */
export function checkListingPhotos(images: unknown): ListingCompletenessProblem | null {
  const count = Array.isArray(images)
    ? images.filter((v) => typeof v === 'string' && v.trim() !== '').length
    : 0
  return count >= MIN_LISTING_PHOTOS
    ? null
    : { code: 'tooFew', field: 'photos', min: MIN_LISTING_PHOTOS }
}

/**
 * Decide a whole listing. Returns the first problem in form order, or null when
 * every required field is answered.
 */
export function checkListingCompleteness(
  input: ListingCompletenessInput
): ListingCompletenessProblem | null {
  return (
    checkListingDescription(input.description) ??
    checkListingAddress(input.location) ??
    checkListingArea(input) ??
    checkListingPinPresence(input.lat, input.lng) ??
    checkListingPropertyType(input.property_type) ??
    checkListingPhotos(input.images)
  )
}

/** A patch, as the edit doors receive it: only the keys the host actually
 *  changed are present. `undefined` means "not touched", which is NOT the same
 *  as "cleared" — clearing sends an empty value, and that is refused. */
export type ListingEditPatch = ListingCompletenessInput

/**
 * The listing as it stands in the database. Only the fields whose rule spans
 * more than one column are needed: the pin is a lat/lng pair, and the area can
 * be answered by a region or by a resort, so half a patch has to be judged
 * against the half already stored.
 */
export interface ListingCurrentState {
  region?: unknown
  resort_id?: unknown
  resort_name?: unknown
  lat?: unknown
  lng?: unknown
}

/**
 * Decide an EDIT. Same rules as `checkListingCompleteness`, applied only to the
 * fields the patch touches.
 *
 * Why not simply re-run the create check on the merged row? Because a patch is
 * partial by design and the untouched parts are none of this edit's business.
 * `PATCH { ownership_doc }` — which is exactly what the iOS app sends to
 * re-submit a proof document — carries no description, and refusing it over one
 * the listing never had would block a host from answering a moderator. The rule
 * that actually matters is that an edit may not make a listing *worse*, and
 * clearing a field is touching it, so that rule is fully covered here.
 *
 * The two-column fields are merged before judging: patching `lat` alone is still
 * judged as a pin (against the stored `lng`), and swapping a region on a listing
 * that names a resort is still judged as an area.
 */
export function checkListingEdit(
  patch: ListingEditPatch,
  current: ListingCurrentState = {}
): ListingCompletenessProblem | null {
  const touched = (key: keyof ListingEditPatch) => patch[key] !== undefined
  /** The value this edit will leave behind: the patch's, or the stored one. */
  const after = (key: keyof ListingCurrentState) =>
    patch[key as keyof ListingEditPatch] !== undefined
      ? patch[key as keyof ListingEditPatch]
      : current[key]

  if (touched('description')) {
    const problem = checkListingDescription(patch.description)
    if (problem) return problem
  }
  if (touched('location')) {
    const problem = checkListingAddress(patch.location)
    if (problem) return problem
  }
  if (touched('region') || touched('resort_id') || touched('resort_name')) {
    const problem = checkListingArea({
      region: after('region'),
      resort_id: after('resort_id'),
      resort_name: after('resort_name'),
    })
    if (problem) return problem
  }
  if (touched('lat') || touched('lng')) {
    const problem = checkListingPinPresence(after('lat'), after('lng'))
    if (problem) return problem
  }
  if (touched('property_type')) {
    const problem = checkListingPropertyType(patch.property_type)
    if (problem) return problem
  }
  if (touched('images')) {
    const problem = checkListingPhotos(patch.images)
    if (problem) return problem
  }
  return null
}

/** One-shot for the edit door: the message to show, or null when the patch is
 *  acceptable. */
export function validateListingEdit(
  patch: ListingEditPatch,
  current: ListingCurrentState = {}
): string | null {
  const problem = checkListingEdit(patch, current)
  return problem ? listingCompletenessProblemMessage(problem) : null
}

/** True when `checkListingCompleteness` has nothing to say — the gate on a
 *  submit button. */
export function isListingComplete(input: ListingCompletenessInput): boolean {
  return checkListingCompleteness(input) === null
}

/** What the field is called in a sentence, so one message table covers six
 *  fields without six near-identical strings. */
function fieldLabel(field: ListingRequiredField): string {
  switch (field) {
    case 'description': return 'a description'
    case 'location':    return 'an address'
    case 'region':      return 'an area'
    case 'pin':         return 'a map pin'
    case 'propertyType':return 'a property type'
    case 'photos':      return 'a photo'
  }
}

/**
 * The plain-English sentence the API returns as `error`. Clients that localize
 * read the problem code and field instead; this is what every other caller
 * renders.
 */
export function listingCompletenessProblemMessage(problem: ListingCompletenessProblem): string {
  switch (problem.code) {
    case 'required':
      return problem.field === 'pin'
        ? 'Please place your listing on the map'
        : `Please add ${fieldLabel(problem.field)} for your listing`
    case 'letters':
      return `Please write ${fieldLabel(problem.field)} in words — it can’t be only symbols or numbers`
    case 'tooShort':
      return problem.field === 'description'
        ? `Please write a fuller description — at least ${problem.min} letters`
        : `Please give a fuller address — at least ${problem.min} letters`
    case 'tooFew':
      return `Please add at least ${problem.min} photo of your listing`
  }
}

/** One-shot: the message to show, or null when the listing is complete. */
export function validateListingCompleteness(input: ListingCompletenessInput): string | null {
  const problem = checkListingCompleteness(input)
  return problem ? listingCompletenessProblemMessage(problem) : null
}
