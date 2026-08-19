// =============================================================================
// LISTING TITLE POLICY — the one place that decides whether a title is a title
// =============================================================================
// Pure logic, no imports, so the same code runs in the API routes, in the host
// forms, and under `node --test`. Keep it that way — see README → Testing.
//
// Create-listing asked for a non-empty string, so `@@@@@` and `!!!!!` published
// a listing whose title is `@@@@@`. That title is the whole listing on the
// explore grid, in search results, in the booking request a host gets and in
// every notification that names the stay — a field that only checks for
// emptiness is not checking anything. Every path that sets a title runs
// `checkListingTitle`: `createListing`, the title branch of the edit patch, and
// the three host-facing forms that post to them.
//
// The rule that does the work is `letters`: a title must contain letters. Not
// "must be Latin", not "must not contain punctuation" — `Nile-view flat (2BR)`
// and `شقة بإطلالة على النيل` are both real titles, and Franco-Arabic writes
// real words with numerals (`Sa7el chalet`). What it refuses is a title with no
// letters *at all*: `@@@@@`, `!!!!!`, `12345`, `-----`, `٠١٢٣`.
//
// Mirrors name-policy.ts deliberately — same problem, same shape, so a reader
// who knows one knows the other. See [[name-policy]] for the longer rationale.
// =============================================================================

/** Enough letters to be a word. `A5` is a door number, not a listing title. */
export const MIN_TITLE_LETTERS = 3

/** What the edit path has always capped titles at — now refused, not truncated. */
export const MAX_TITLE_LENGTH = 200

/**
 * Why a title was refused.
 *
 * Structured like `NameProblem` in name-policy.ts and for the same reason: the
 * API echoes the code so a client can localize the reason without re-deciding it.
 */
export type ListingTitleProblemCode = 'required' | 'letters' | 'tooShort' | 'tooLong'

export interface ListingTitleProblem {
  code: ListingTitleProblemCode
}

// A letter in any script — `\p{L}` covers Arabic, Latin, Cyrillic and the CJK
// ideographs alike, which is the whole point of using it over /[A-Za-z]/.
const HAS_LETTER = /\p{L}/u

// Invisible characters people paste in without meaning to: the soft hyphen, the
// Mongolian vowel separator, the zero-width spaces and bidi marks, the BOM. They
// survive a `.trim()` and render as nothing, so a title made only of them would
// otherwise read as non-empty — strip them before anything else looks.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu

/**
 * What gets stored: invisibles dropped, every run of whitespace collapsed to one
 * space, ends trimmed. `  Nile   view  ` and `Nile view` are one title, and
 * storing the first means the explore grid renders a gap nobody typed.
 */
export function normalizeListingTitle(title: unknown): string {
  return String(title ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** How many letters the title actually contains, in any script. */
function letterCount(title: string): number {
  let count = 0
  for (const ch of title) {
    if (HAS_LETTER.test(ch)) count++
  }
  return count
}

/**
 * Decide a title. Returns the first problem, or null when it is acceptable.
 *
 * Order matters: `letters` is checked before `tooShort` so `@@@@@` is told the
 * thing that is actually wrong with it ("a title needs words") rather than being
 * sent back to add a sixth `@`.
 */
export function checkListingTitle(title: unknown): ListingTitleProblem | null {
  const value = normalizeListingTitle(title)
  if (!value) return { code: 'required' }
  // Count code points, not UTF-16 units — an emoji is one character to whoever
  // typed it, and a title of 200 Arabic characters must not read as 400.
  if ([...value].length > MAX_TITLE_LENGTH) return { code: 'tooLong' }

  const letters = letterCount(value)
  if (letters === 0) return { code: 'letters' }
  if (letters < MIN_TITLE_LETTERS) return { code: 'tooShort' }
  return null
}

/** True when `checkListingTitle` has nothing to say — the gate on a submit button. */
export function isValidListingTitle(title: unknown): boolean {
  return checkListingTitle(title) === null
}

/**
 * The plain-English sentence the API returns as `error`. Clients that localize
 * read the problem code instead; this is what every other caller renders.
 */
export function listingTitleProblemMessage(problem: ListingTitleProblem): string {
  switch (problem.code) {
    case 'required':
      return 'Please give your listing a title'
    case 'letters':
      return 'Please describe your listing in words — a title can’t be only symbols or numbers'
    case 'tooShort':
      return `Listing title must contain at least ${MIN_TITLE_LETTERS} letters`
    case 'tooLong':
      return `Listing title must be at most ${MAX_TITLE_LENGTH} characters`
  }
}

/** One-shot: the message to show, or null when the title is acceptable. */
export function validateListingTitle(title: unknown): string | null {
  const problem = checkListingTitle(title)
  return problem ? listingTitleProblemMessage(problem) : null
}
