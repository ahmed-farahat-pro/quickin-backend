// =============================================================================
// NAME POLICY — the one place that decides whether a name is a name
// =============================================================================
// Pure logic, no imports, so the same code runs in the API routes, in the client
// forms, and under `node --test`. Keep it that way — see README → Testing.
//
// Signup asked for a non-empty string, so `12345` created an account whose
// display name is `12345`. That name is what a host sees next to a booking
// request, what a review is signed with, and what an operator matches against
// an ID document at verification time — a field that only checks for emptiness
// is not checking anything. Every path that sets a name calls `checkName`:
// both signup routes, `signUpSchema`, the host application, and the iOS twin.
//
// The rule that does the work is `letters`: a name must contain letters. Not
// "must be Latin", not "must not contain digits" — Franco-Arabic writes real
// names with numerals (`Ma7moud`, `3omar`) and refusing those would turn away
// exactly the guests this app is built for. What it refuses is a name with no
// letters *at all*: `12345`, `0100`, `٠١٢٣`, `----`.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy, and both
// create accounts in the same `users` table. If the mobile API accepted a name
// the web refused, the rule would only hold on whichever door a guest happened
// to use. `scripts/check-name-policy-parity.mjs` fails if they drift, so edit
// one copy and paste it over the other verbatim.
// =============================================================================

/** Two letters. A one-character name is almost always a slip, not a mononym. */
export const MIN_NAME_LETTERS = 2

/** Long enough for a full Arabic name with all its parts, short enough to render. */
export const MAX_NAME_LENGTH = 60

/**
 * Why a name was refused.
 *
 * Structured like `PasswordProblem` in password-policy.ts and for the same
 * reason: the API echoes the code so a client can localize the reason without
 * re-deciding it.
 */
export type NameProblemCode = 'required' | 'letters' | 'tooShort' | 'tooLong'

export interface NameProblem {
  code: NameProblemCode
}

// A letter in any script — `\p{L}` covers Arabic, Latin, Cyrillic and the CJK
// ideographs alike, which is the whole point of using it over /[A-Za-z]/.
const HAS_LETTER = /\p{L}/u

// Invisible characters people paste in without meaning to: the soft hyphen, the
// Mongolian vowel separator, the zero-width spaces and bidi marks, the BOM. They
// survive a `.trim()` and render as nothing, so a name made only of them would
// otherwise read as non-empty — strip them before anything else looks.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu

/**
 * What gets stored: invisibles dropped, every run of whitespace collapsed to one
 * space, ends trimmed. `  Layla   Hassan  ` and `Layla Hassan` are one name, and
 * storing the second means a host never sees the first.
 */
export function normalizeName(name: unknown): string {
  return String(name ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** How many letters the name actually contains, in any script. */
function letterCount(name: string): number {
  let count = 0
  for (const ch of name) {
    if (HAS_LETTER.test(ch)) count++
  }
  return count
}

/**
 * Decide a name. Returns the first problem, or null when it is acceptable.
 *
 * Order matters: `letters` is checked before `tooShort` so `5` is told the thing
 * that is actually wrong with it ("names contain letters") rather than being
 * sent back to add a second digit.
 */
export function checkName(name: unknown): NameProblem | null {
  const value = normalizeName(name)
  if (!value) return { code: 'required' }
  // Count code points, not UTF-16 units — an emoji is one character to whoever
  // typed it, and a name of 60 Arabic characters must not read as 120.
  if ([...value].length > MAX_NAME_LENGTH) return { code: 'tooLong' }

  const letters = letterCount(value)
  if (letters === 0) return { code: 'letters' }
  if (letters < MIN_NAME_LETTERS) return { code: 'tooShort' }
  return null
}

/** True when `checkName` has nothing to say — the gate on a submit button. */
export function isValidName(name: unknown): boolean {
  return checkName(name) === null
}

/**
 * The plain-English sentence the API returns as `error`. Clients that localize
 * read `nameProblem.code` instead; this is what every other caller renders.
 */
export function nameProblemMessage(problem: NameProblem): string {
  switch (problem.code) {
    case 'required':
      return 'Please enter your name'
    case 'letters':
      return 'Please enter your name — a name contains letters, not only numbers'
    case 'tooShort':
      return `Name must contain at least ${MIN_NAME_LETTERS} letters`
    case 'tooLong':
      return `Name must be at most ${MAX_NAME_LENGTH} characters`
  }
}

/** One-shot: the message to show, or null when the name is acceptable. */
export function validateName(name: unknown): string | null {
  const problem = checkName(name)
  return problem ? nameProblemMessage(problem) : null
}

/**
 * The display name for an account created without one — a social login that
 * returned no name, or an older client that posts no `full_name`.
 *
 * The local part of the address is the best guess available, but it is guest
 * input too: `0100@gmail.com` would seed exactly the numeric-only name this
 * policy exists to refuse. When it isn't a usable name, say `Guest` rather than
 * storing something the policy would have rejected at the front door.
 */
export function fallbackNameFromEmail(email: unknown): string {
  const localPart = normalizeName(String(email ?? '').split('@')[0])
  return isValidName(localPart) ? localPart : 'Guest'
}
