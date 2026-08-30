// =============================================================================
// LISTING CAPACITY POLICY — what a place has to have to be a place
// =============================================================================
// Create-listing floored bedrooms, beds and bathrooms at **zero**: the form's
// `num()` helper kept anything `>= 0`, the number inputs carried `min="0"`, and
// `createListing` wrote the value straight through. A host could publish a
// chalet with 0 bedrooms, 0 beds and 0 bathrooms — and a stay with nowhere to
// sleep is not a stay. Worse, those three numbers are the line under every
// listing card ("0 bedrooms · 0 beds · 0 baths"), they are what a guest filters
// and compares on, and `max_guests` at 0 makes a listing that cannot be booked
// at all (bookings check `guests <= max_guests`).
//
// The floor is deliberately dull: each of the four counts is a whole number of
// at least one.
//
// The CEILING is the other half, and it was missing. Nothing refused a number
// from above, so a host could publish a Studio with **27,373 bedrooms** (a real
// row on Neon) or a Cabin with 40 — numbers that mean nothing, sort to the top
// of a bedrooms filter, and read as a broken product rather than a typo. Two
// kinds of ceiling now sit here:
//
//   - Bedrooms are capped PER PROPERTY TYPE (see MAX_BEDROOMS_BY_PROPERTY_TYPE),
//     because "too many" only means something once you know what the place is:
//     8 bedrooms is an ordinary villa and an impossible guest suite.
//   - Beds, bathrooms and guests get one blanket sanity ceiling each. They have
//     no per-type table, but the same keypad types into them, so leaving them
//     unbounded would just move 27,373 one field to the right.
//
// The ceilings are the numbers product asked for, not physics, and they are
// enforced on the edit door as well as on create — a stored row that exceeds
// them (there are a handful, all unpublished) is shown as it is and blocks Save
// until the host corrects it. That is the same treatment a stored 0 already got.
//
// Pure logic, no imports, so the same code runs in `db.ts`, in the three host
// forms and under `node --test` — see README → Testing. Callers import the core,
// never the reverse. Mirrors listing-title-policy.ts and profile-core.ts: same
// problem shape, same `check` / `message` / `validate` trio, so a reader who
// knows one knows this one.
// =============================================================================

/** The four counts that describe a property's capacity. */
export const CAPACITY_FIELDS = ['bedrooms', 'beds', 'bathrooms', 'guests'] as const

export type ListingCapacityField = (typeof CAPACITY_FIELDS)[number]

/**
 * The floor, for every field.
 *
 * One, not zero. A studio is entered as 1 bedroom rather than 0 — the property
 * type already says "Studio", and a listing whose whole capacity line reads
 * zeroes tells a guest nothing. If studios should instead be allowed 0 bedrooms
 * the way some other platforms model them, this is the one constant to change
 * (and the one test to update); today's rule is the one the form, the API and
 * both edit doors all read from here.
 */
export const MIN_CAPACITY = 1

/**
 * The most bedrooms each property type may claim.
 *
 * Product's table, keyed by the stored English property_type lowercased (the
 * value is stored in English on purpose — clients translate the label only — so
 * a case-insensitive key is the whole normalisation this needs).
 *
 * **Studio is 1, not 0.** Product wrote "must be 0", meaning a studio is a
 * single room with no separate bedroom. MIN_CAPACITY is 1, and the two
 * statements are the same statement: the one room IS the bedroom. Writing 0
 * here would make every studio unpublishable, so the intent is expressed as an
 * exact 1 — a studio has one bedroom and may not claim two.
 */
export const MAX_BEDROOMS_BY_PROPERTY_TYPE: Readonly<Record<string, number>> = {
  apartment: 5,
  house: 6,
  villa: 8,
  cabin: 3,
  studio: 1,
  loft: 3,
  chalet: 6,
  cottage: 4,
  'guest suite': 2,
}

/**
 * The bedroom ceiling for a type the table above does not name.
 *
 * Set to the most permissive number product gave (Villa's 8) on purpose: an
 * unlisted type — 'Guest House', which the API accepts and the Android picker
 * offers, or anything a future release adds — should never be judged HARDER
 * than a type product has actually ruled on. Add the type to the table to
 * tighten it.
 */
export const DEFAULT_MAX_BEDROOMS = 8

/**
 * The blanket ceiling on the three counts with no per-type table.
 *
 * These are the ceilings the mobile steppers have offered all along, promoted
 * from "as far as the control scrolls" to an actual rule so the API refuses
 * what the stepper could never have produced. Bedrooms is absent — it is
 * per-type, and `maxListingCapacity` is what resolves it.
 */
export const MAX_CAPACITY: Readonly<Record<Exclude<ListingCapacityField, 'bedrooms'>, number>> = {
  beds: 30,
  bathrooms: 20,
  guests: 32,
}

/**
 * Why a count was refused.
 *
 * Structured like `ListingTitleProblem` and for the same reason: the API echoes
 * the code and the field so a client can localize the reason without
 * re-deciding it. `max` travels with every problem alongside `min` so a message
 * can name the bound it missed without importing the tables.
 */
export type ListingCapacityProblemCode = 'required' | 'notWhole' | 'tooFew' | 'tooMany'

export interface ListingCapacityProblem {
  code: ListingCapacityProblemCode
  field: ListingCapacityField
  /** The floor that was missed — so a message can name it without importing it. */
  min: number
  /** The ceiling that was exceeded, resolved for this field and property type. */
  max: number
  /**
   * The property type the ceiling came from, canonical-cased for a sentence, or
   * null when the field has no per-type rule (beds, bathrooms, guests) or the
   * caller never said what the place was.
   */
  propertyType: string | null
}

// Invisible characters people paste in without meaning to — the same set
// listing-title-policy.ts strips, and for the same reason: they survive a
// `.trim()`, so a field holding only them would otherwise read as filled in.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu

/**
 * Arabic-Indic and Persian digits folded to ASCII, so `٣` typed on an Arabic
 * keyboard is the three it plainly is. `profile-core.ts` and `phone-core.ts`
 * fold the same two ranges; the site runs in Arabic, and these numbers arrive
 * from the mobile apps as JSON where the browser's number input is no help.
 */
export function toAsciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.codePointAt(0) as number) & 0xf))
}

/** True when the field was left empty — told apart from wrong, because "you
 *  skipped this" and "that isn't a number" are different things to fix. */
export function isBlankCapacity(v: unknown): boolean {
  if (v === null || v === undefined) return true
  return String(v).replace(INVISIBLE, '').trim() === ''
}

/**
 * The count to store, or `null` when the value is not a plain whole number.
 *
 * Deliberately strict: `Number()` alone accepts `2.5`, `1e3`, `0x2`, `true` and
 * `['2']`, and `Math.floor(Number(v))` — what the form and `createListing` used
 * to do — turned `2.9` into 2 and `'abc'` into a default nobody typed. Callers
 * ask `checkListingCapacity` first and only reach here once it has said yes.
 */
export function parseCapacity(v: unknown): number | null {
  if (isBlankCapacity(v)) return null
  // Reject the JSON shapes String() would happily flatten into a digit string:
  // `[2]` becomes `'2'` and `true` becomes `'true'`, and only one of those is
  // even arguably a number.
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'number' && !Number.isInteger(v)) return null
  const raw = toAsciiDigits(String(v)).replace(INVISIBLE, '').trim()
  if (!/^\d{1,6}$/.test(raw)) return null
  return Number(raw)
}

/**
 * The property type as MAX_BEDROOMS_BY_PROPERTY_TYPE keys it, or null when the
 * caller said nothing usable.
 *
 * Lowercased, invisible characters stripped, and inner runs of whitespace
 * collapsed — 'Guest  suite' and 'guest suite' are the same type, and only one
 * of them would otherwise find the table.
 */
export function normalizePropertyTypeKey(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const key = String(v).replace(INVISIBLE, '').trim().replace(/\s+/g, ' ').toLowerCase()
  return key === '' ? null : key
}

/**
 * The ceiling for one field, given what the place is.
 *
 * Bedrooms read the per-type table and fall back to DEFAULT_MAX_BEDROOMS for a
 * type nobody has ruled on; the other three ignore `propertyType` entirely.
 */
export function maxListingCapacity(field: ListingCapacityField, propertyType?: unknown): number {
  if (field !== 'bedrooms') return MAX_CAPACITY[field]
  const key = normalizePropertyTypeKey(propertyType)
  if (key === null) return DEFAULT_MAX_BEDROOMS
  const max = MAX_BEDROOMS_BY_PROPERTY_TYPE[key]
  return max === undefined ? DEFAULT_MAX_BEDROOMS : max
}

/**
 * How the property type is spelled in an error sentence, or null when it has no
 * bearing on this field's ceiling.
 *
 * Only a type the table actually names is echoed: telling a host "a Guest House
 * can have at most 8 bedrooms" would state a rule that does not exist for their
 * type, so an unlisted one falls back to the impersonal sentence.
 */
function propertyTypeForMessage(field: ListingCapacityField, propertyType?: unknown): string | null {
  if (field !== 'bedrooms') return null
  const key = normalizePropertyTypeKey(propertyType)
  if (key === null || MAX_BEDROOMS_BY_PROPERTY_TYPE[key] === undefined) return null
  return key.replace(/\b[a-z]/, (c) => c.toUpperCase())
}

/**
 * Decide one count. Returns the problem, or null when it is acceptable.
 *
 * Order matters, same as everywhere else in this codebase: an empty field hears
 * `required` rather than being told that nothing is not a whole number, and a
 * value is only measured against the ceiling once it is known to be a number.
 *
 * `propertyType` is what the listing says it is — the value being saved, not
 * the one already stored, because a host who retypes a 6-bedroom Villa as a
 * Cabin is changing both halves of the rule at once. Omit it and bedrooms are
 * judged against DEFAULT_MAX_BEDROOMS.
 */
export function checkListingCapacity(
  field: ListingCapacityField,
  v: unknown,
  propertyType?: unknown
): ListingCapacityProblem | null {
  const max = maxListingCapacity(field, propertyType)
  const named = propertyTypeForMessage(field, propertyType)
  const base = { field, min: MIN_CAPACITY, max, propertyType: named }
  if (isBlankCapacity(v)) return { code: 'required', ...base }
  const n = parseCapacity(v)
  if (n === null) return { code: 'notWhole', ...base }
  if (n < MIN_CAPACITY) return { code: 'tooFew', ...base }
  if (n > max) return { code: 'tooMany', ...base }
  return null
}

/** True when `checkListingCapacity` has nothing to say — the gate on a submit button. */
export function isValidListingCapacity(
  field: ListingCapacityField,
  v: unknown,
  propertyType?: unknown
): boolean {
  return checkListingCapacity(field, v, propertyType) === null
}

/** How each field is named in a sentence, singular and plural. */
const FIELD_WORDS: Record<ListingCapacityField, { one: string; many: string }> = {
  bedrooms: { one: 'bedroom', many: 'bedrooms' },
  beds: { one: 'bed', many: 'beds' },
  bathrooms: { one: 'bathroom', many: 'bathrooms' },
  guests: { one: 'guest', many: 'guests' },
}

/**
 * The plain-English sentence the API returns as `error`. Clients that localize
 * read `problem.code` + `problem.field` instead; this is what every other caller
 * renders — including the mobile apps, which have no copy for this rule yet.
 */
export function listingCapacityProblemMessage(problem: ListingCapacityProblem): string {
  const words = FIELD_WORDS[problem.field]
  const noun = problem.min === 1 ? words.one : words.many
  const capNoun = problem.max === 1 ? words.one : words.many
  switch (problem.code) {
    case 'required':
      return problem.field === 'guests'
        ? 'Please say how many guests this place sleeps'
        : `Please say how many ${words.many} this place has`
    case 'notWhole':
      return problem.field === 'guests'
        ? 'Guests must be a whole number, like 4'
        : `${words.many[0].toUpperCase()}${words.many.slice(1)} must be a whole number, like 2`
    case 'tooFew':
      return problem.field === 'guests'
        ? `A listing has to sleep at least ${problem.min} ${noun}`
        : `A listing needs at least ${problem.min} ${noun}`
    case 'tooMany':
      if (problem.field === 'guests') return `A listing can sleep at most ${problem.max} ${capNoun}`
      // A studio's ceiling equals its floor, so "at most 1 bedroom" is true but
      // reads like a cap the host could work under. Say the actual shape of the
      // place instead.
      if (problem.propertyType && problem.max === MIN_CAPACITY) {
        return `A ${problem.propertyType} is a single room — it has exactly ${problem.max} ${capNoun}`
      }
      return problem.propertyType
        ? `A ${problem.propertyType} can have at most ${problem.max} ${capNoun}`
        : `A listing can have at most ${problem.max} ${capNoun}`
  }
}

/** One-shot: the message to show, or null when the count is acceptable. */
export function validateListingCapacity(
  field: ListingCapacityField,
  v: unknown,
  propertyType?: unknown
): string | null {
  const problem = checkListingCapacity(field, v, propertyType)
  return problem ? listingCapacityProblemMessage(problem) : null
}
