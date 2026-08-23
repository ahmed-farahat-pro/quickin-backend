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
// signup, the profile save behind Edit profile, the host application, and the
// iOS and Android twins.
//
// The rule that does the work is `invalidCharacters`: a name is made of letters
// and nothing else. Letters in any script — `\p{L}` takes Arabic, Latin,
// Cyrillic and the CJK ideographs alike — plus the marks that sit on top of them
// (`\p{M}`: harakat, a Devanagari matra, the accent in a decomposed `José`), and
// the three characters that hold a real name together: the space between its
// parts, the hyphen in `Jean-Luc`, the apostrophe in `O'Brien`. Digits, `@`, `.`,
// `_`, emoji and every other symbol are refused.
//
// This is stricter than the rule that shipped first, which asked only that a
// name contain *some* letter and so accepted Franco-Arabic spellings like
// `Ma7moud` and `3omar`. Those are refused now — the field is a legal-ish name
// matched against an ID document at verification, and `Ma7moud` is not what the
// document says. A guest who writes it that way is asked for `Mahmoud`. Names
// already stored with a digit stay as they are until the account next saves a
// name, at which point this rule applies to it like any other.
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
export type NameProblemCode = 'required' | 'invalidCharacters' | 'letters' | 'tooShort' | 'tooLong'

export interface NameProblem {
  code: NameProblemCode
}

// A letter in any script — `\p{L}` covers Arabic, Latin, Cyrillic and the CJK
// ideographs alike, which is the whole point of using it over /[A-Za-z]/.
const HAS_LETTER = /\p{L}/u

// Anything that is not part of a name. The allowed set, read from the inside
// out: a letter in any script, a combining mark (harakat, a Devanagari matra,
// the accent of a decomposed `José` — dropping these would break the very
// scripts `\p{L}` was chosen for), the space between the parts of a name, the
// apostrophe of `O'Brien`, the hyphen of `Jean-Luc`.
//
// Both punctuation marks are listed twice because a phone does not send the one
// on the keycap: iOS and Android smart punctuation turn `'` into `’` (U+2019) as
// it is typed, and a name pasted from a document carries the typographic hyphens
// (U+2010, U+2011) with it. Refusing those would refuse `O’Brien` for a
// substitution the guest never made and cannot see.
//
// Only U+0020 is listed for the space because `normalizeName` runs first and has
// already collapsed every other kind of whitespace into it.
const DISALLOWED_NAME_CHAR = /[^\p{L}\p{M} '\u2019\-\u2010\u2011]/u

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
 * Order matters. `invalidCharacters` is decided before `letters` and
 * `tooShort`, so `5` and `A1` are told the thing that is actually wrong with
 * them ("a name is letters only") rather than being sent back to type another
 * character. `letters` survives that for the inputs made entirely of the
 * punctuation this rule does allow — `-----`, `'''` — which are legal
 * characters arranged into something that is still not a name.
 */
export function checkName(name: unknown): NameProblem | null {
  const value = normalizeName(name)
  if (!value) return { code: 'required' }
  // Count code points, not UTF-16 units — an emoji is one character to whoever
  // typed it, and a name of 60 Arabic characters must not read as 120.
  if ([...value].length > MAX_NAME_LENGTH) return { code: 'tooLong' }
  if (DISALLOWED_NAME_CHAR.test(value)) return { code: 'invalidCharacters' }

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
    case 'invalidCharacters':
      return 'Please use letters only — a name has no numbers or symbols in it'
    case 'letters':
      return 'Please enter your name — a name contains letters'
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

// The characters an address uses to separate the words of a name: `.`, `_` and
// the `+` of a tagged address. In `layla.hassan@…` they stand where a space
// stands, so the fallback below reads them as one before it judges the result.
const EMAIL_WORD_SEPARATORS = /[._+]+/gu

/**
 * The display name for an account created without one — a social login that
 * returned no name, or an older client that posts no `full_name`.
 *
 * The local part of the address is the best guess available, but it is guest
 * input too: `0100@gmail.com` would seed exactly the name this policy exists to
 * refuse, and `ma7moud@gmail.com` the Franco-Arabic spelling it refuses now.
 * Separators become spaces, because `layla.hassan` is a name written the only
 * way an address lets you write it — but nothing else is rewritten. A local part
 * that still holds a digit is not quietly stripped down to a name the guest
 * never typed; it says `Guest`, and the guest tells us who they are later.
 */
export function fallbackNameFromEmail(email: unknown): string {
  const localPart = normalizeName(String(email ?? '').split('@')[0].replace(EMAIL_WORD_SEPARATORS, ' '))
  return isValidName(localPart) ? localPart : 'Guest'
}
