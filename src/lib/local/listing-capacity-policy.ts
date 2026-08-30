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
// The rule is deliberately dull: each of the four counts is a whole number of at
// least one. There is no upper bound here — an unusually large villa is not an
// error, and a cap invented in this module would start refusing edits to rows
// that already exist.
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
 * Why a count was refused.
 *
 * Structured like `ListingTitleProblem` and for the same reason: the API echoes
 * the code and the field so a client can localize the reason without
 * re-deciding it.
 */
export type ListingCapacityProblemCode = 'required' | 'notWhole' | 'tooFew'

export interface ListingCapacityProblem {
  code: ListingCapacityProblemCode
  field: ListingCapacityField
  /** The floor that was missed — so a message can name it without importing it. */
  min: number
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
 * Decide one count. Returns the problem, or null when it is acceptable.
 *
 * Order matters, same as everywhere else in this codebase: an empty field hears
 * `required` rather than being told that nothing is not a whole number.
 */
export function checkListingCapacity(
  field: ListingCapacityField,
  v: unknown
): ListingCapacityProblem | null {
  if (isBlankCapacity(v)) return { code: 'required', field, min: MIN_CAPACITY }
  const n = parseCapacity(v)
  if (n === null) return { code: 'notWhole', field, min: MIN_CAPACITY }
  if (n < MIN_CAPACITY) return { code: 'tooFew', field, min: MIN_CAPACITY }
  return null
}

/** True when `checkListingCapacity` has nothing to say — the gate on a submit button. */
export function isValidListingCapacity(field: ListingCapacityField, v: unknown): boolean {
  return checkListingCapacity(field, v) === null
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
  }
}

/** One-shot: the message to show, or null when the count is acceptable. */
export function validateListingCapacity(
  field: ListingCapacityField,
  v: unknown
): string | null {
  const problem = checkListingCapacity(field, v)
  return problem ? listingCapacityProblemMessage(problem) : null
}
