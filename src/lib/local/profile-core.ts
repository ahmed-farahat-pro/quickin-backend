// =============================================================================
// PROFILE POLICY — what an age and an "about me" have to look like
// =============================================================================
// The three fields the apps have always had on Edit profile — age, phone and bio
// — reached the web with nothing deciding what they may hold, because the web
// never had them at all: `/account` edited the name and nothing else, while iOS
// and Android wrote `users.age`, `users.phone` and `users.bio` through the
// backend's `/api/local/profile`. One person editing their profile on the phone
// and on the site was editing two different profiles.
//
// Phone is NOT here — it already has a home in `phone-core.ts`, which the host
// application and both APIs share, and a second opinion about what a phone
// number is would be exactly the kind of drift that module exists to prevent.
// This module is the age and the bio, and nothing else.
//
// Pure logic, no imports, so the same code runs in the API route, in the client
// form and under `node --test` — see README → Testing. Callers import the core,
// never the reverse.
// =============================================================================

/**
 * The narrowest and widest age we will store.
 *
 * This is a plausibility check, not an eligibility rule. `0`, `4` and `999` are
 * a slipped keystroke on a number pad, and a profile that shows one to a host is
 * worse than a form that pushes back. Whether an account has to be 18 to book is
 * a product decision that lives with bookings, not with a profile field — if it
 * is ever made, it belongs at the booking door where it can be enforced against
 * an ID, not here where the number is self-declared.
 */
export const MIN_AGE = 13
export const MAX_AGE = 120

/** Long enough to introduce yourself, short enough to render under a name. */
export const MAX_BIO_LENGTH = 500

/**
 * Why an age was refused. Structured like `NameProblem` in name-policy.ts and
 * for the same reason: the API echoes the code so a client can localize the
 * reason without re-deciding it.
 */
export type AgeProblemCode = 'notANumber' | 'tooYoung' | 'tooOld'

export interface AgeProblem {
  code: AgeProblemCode
}

export type BioProblemCode = 'tooLong'

export interface BioProblem {
  code: BioProblemCode
}

// Invisible characters people paste in without meaning to — the same set
// name-policy.ts strips, and for the same reason: they survive a `.trim()` and
// render as nothing, so a bio made only of them would otherwise read as filled
// in, and 500 of them would read as a full one.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu

/**
 * Arabic-Indic and Persian digits folded to ASCII, so an age typed on an Arabic
 * keyboard (`٣٤`) is the number it plainly is. `phone-core.ts` folds the same
 * two ranges for the same reason; the site runs in Arabic and a field that only
 * understood ASCII would refuse a guest typing their own age correctly.
 */
export function toAsciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.codePointAt(0) as number) & 0xf))
}

/**
 * True when a field was left empty — which is not an error for any of these.
 * Age, phone and bio are all optional, and clearing one is a thing a person is
 * allowed to do, so blank has to be told apart from wrong rather than lumped in
 * with it.
 */
export function isBlankField(v: unknown): boolean {
  if (v === null || v === undefined) return true
  return String(v).replace(INVISIBLE, '').trim() === ''
}

/**
 * The age to store: a whole number, or `null` when the field was cleared.
 *
 * Returns `null` for anything that is not a plain whole number too — callers ask
 * `checkAge` first and only reach here once it has said yes, so the two never
 * disagree about a value that would be stored.
 */
export function parseAge(v: unknown): number | null {
  if (isBlankField(v)) return null
  const raw = toAsciiDigits(String(v)).trim()
  // Deliberately strict: `Number()` alone accepts `34.5`, `3e2`, `0x22` and
  // ` 34 \n`, and an age of 300 arriving as `3e2` is exactly the kind of value
  // the range check below would then wave through.
  if (!/^\d{1,3}$/.test(raw)) return null
  return Number(raw)
}

/**
 * Decide an age. Returns the first problem, or null when it is acceptable —
 * which includes an empty field, since age is optional.
 */
export function checkAge(v: unknown): AgeProblem | null {
  if (isBlankField(v)) return null
  const age = parseAge(v)
  if (age === null) return { code: 'notANumber' }
  if (age < MIN_AGE) return { code: 'tooYoung' }
  if (age > MAX_AGE) return { code: 'tooOld' }
  return null
}

/** True when `checkAge` has nothing to say — the gate on a submit button. */
export function isValidAge(v: unknown): boolean {
  return checkAge(v) === null
}

/**
 * The plain-English sentence the API returns as `error`. Clients that localize
 * read `ageProblem.code` instead; this is what every other caller renders.
 */
export function ageProblemMessage(problem: AgeProblem): string {
  switch (problem.code) {
    case 'notANumber':
      return 'Please enter your age as a number, like 34'
    case 'tooYoung':
      return `Age must be at least ${MIN_AGE}`
    case 'tooOld':
      return `Age must be at most ${MAX_AGE}`
  }
}

/** One-shot: the message to show, or null when the age is acceptable. */
export function validateAge(v: unknown): string | null {
  const problem = checkAge(v)
  return problem ? ageProblemMessage(problem) : null
}

/**
 * What a bio field should hold after a keystroke: the typed text with invisibles
 * dropped, so a paste out of a chat app cannot spend the character budget on
 * nothing. Line breaks survive — a bio is a paragraph, not a name.
 */
export function filterBioInput(v: string): string {
  return v.replace(INVISIBLE, '').replace(/\r\n?/g, '\n')
}

/**
 * What gets stored: invisibles dropped, line endings normalized, runs of blank
 * lines collapsed to one, ends trimmed. A bio pasted out of a document arrives
 * with six trailing newlines that render as a hole under the name.
 */
export function normalizeBio(v: unknown): string {
  return String(v ?? '')
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    // Spaces left hanging at the ends of a line are invisible to whoever pasted
    // them and would survive the trim below, which only reaches the two ends.
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** How long the bio reads as to whoever typed it: characters, not UTF-16 units. */
export function bioLength(v: unknown): number {
  return [...normalizeBio(v)].length
}

/** Decide a bio. Empty is fine — a bio is optional. */
export function checkBio(v: unknown): BioProblem | null {
  // Count code points, not UTF-16 units: an emoji is one character to the person
  // who typed it, and 300 Arabic characters must not read as 600.
  if (bioLength(v) > MAX_BIO_LENGTH) return { code: 'tooLong' }
  return null
}

/** True when `checkBio` has nothing to say. */
export function isValidBio(v: unknown): boolean {
  return checkBio(v) === null
}

/** The plain-English sentence the API returns as `error`. */
export function bioProblemMessage(problem: BioProblem): string {
  switch (problem.code) {
    case 'tooLong':
      return `About you must be at most ${MAX_BIO_LENGTH} characters`
  }
}

/** One-shot: the message to show, or null when the bio is acceptable. */
export function validateBio(v: unknown): string | null {
  const problem = checkBio(v)
  return problem ? bioProblemMessage(problem) : null
}
