// Resort naming rules — pure, and DELIBERATELY free of runtime imports.
//
// Two reasons this file has no `import` at the top:
//   1. `node --test` can load a .ts module directly (Node 22 strips types), but
//      Node's ESM resolver rejects the extension-less relative specifiers the rest
//      of src/lib/local uses (`from './pool'`). A module with no relative imports
//      is therefore unit-testable as-is. See README → Testing.
//   2. It keeps the dependency direction one-way: db.ts imports this, never the
//      reverse. Nothing here may ever touch `pool`.
//
// This file is BYTE-IDENTICAL in both repos (quickin-backend and quickin-frontend)
// — they share one database but cannot import each other. Drift is fatal: a slug
// computed differently on the web than on iOS silently forks the catalog. The
// backend's scripts/check-resort-core-parity.mjs fails if the two diverge, so edit
// one and copy it over rather than patching each.
//
// NOTE: resortSlug() is also duplicated in scripts/migrate-resorts.mjs, which
// cannot import a .ts module. Keep all three in step.

/** The regions a resort can belong to. A listing's region is DERIVED from its
 *  resort, so this is the single source of truth for both. */
export const REGION_VALUES = ['North Coast', 'Ain Sokhna', 'El Gouna', 'Cairo'] as const
export type Region = (typeof REGION_VALUES)[number]

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGION_VALUES as readonly string[]).includes(value)
}

/** Longest name we store. Long enough for "Sidi Abdel Rahman Bay Resort", short
 *  enough that a paste accident can't fill the column. */
export const MAX_RESORT_NAME = 120

// Invisible characters people paste in without meaning to: the soft hyphen, the
// Mongolian vowel separator, the zero-width spaces and bidi marks, the BOM. They
// survive a `.trim()` and render as nothing, so a name made only of them would
// otherwise read as non-empty — strip them before anything else looks.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu

// A letter in any script — `\p{L}` covers Arabic, Latin, Cyrillic and the CJK
// ideographs alike, which is the whole point of using it over /[A-Za-z]/.
const HAS_LETTER = /\p{L}/u

/**
 * Clean a host-typed resort name for DISPLAY: drop invisibles, collapse
 * whitespace, trim, cap length. Returns null for anything blank, which is how
 * "the host left it empty" is represented everywhere downstream.
 *
 * This preserves the host's capitalisation and punctuation on purpose — the raw
 * text is shown to guests as typed until an admin approves a canonical spelling.
 */
export function normalizeResortName(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const cleaned = input.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, MAX_RESORT_NAME)
  return cleaned.length > 0 ? cleaned : null
}

// ---------------------------------------------------------------------------
// The "Other — not listed" name rule — what may be typed into the free-text box
// ---------------------------------------------------------------------------
// The forms asked only that the box was non-blank, so `@@@@@` and `!!!!!` were
// accepted and the listing submitted. Worse than an ugly catalog entry: a name
// with no alphanumerics slugs to '' (see resortSlug), and the write path reads a
// slug-less name as "no resort chosen" — the host's answer was thrown away, the
// listing missed every resort filter, and nothing queued for the /ops catalog.
// That is the same silent discard `isResortNameMissing` was written to stop, one
// step further along.
//
// The rule that does the work is `letters`: a compound name must contain letters.
// Not "must be Latin", not "must not contain punctuation" — `Marassi (North)`,
// `Sa7el Chalet` and `هاسيندا باي` are all real names a host may type. What it
// refuses is a name with no letters at all: `@@@@@`, `!!!!!`, `12345`, `-----`.
//
// Deliberately the same shape as checkListingTitle in listing-title-policy.ts —
// same problem, same answer, so a reader who knows one knows the other.

/** Enough letters to be a name. `A5` is a villa number, not a compound. */
export const MIN_RESORT_NAME_LETTERS = 2

/**
 * Why a typed resort name was refused. Structured like `ListingTitleProblem`, and
 * for the same reason: the API echoes the code so a client can localize the reason
 * without re-deciding it.
 */
export type ResortNameProblemCode = 'required' | 'letters' | 'tooShort'

export interface ResortNameProblem {
  code: ResortNameProblemCode
}

/** How many letters the name actually contains, in any script. */
function resortNameLetterCount(name: string): number {
  let count = 0
  for (const ch of name) {
    if (HAS_LETTER.test(ch)) count++
  }
  return count
}

/**
 * Decide a host-typed resort name. Returns the first problem, or null when it is
 * acceptable.
 *
 * Order matters: `letters` is checked before `tooShort` so `@@@@@` is told the
 * thing that is actually wrong with it ("write it in words") rather than being
 * sent back to add a sixth `@`.
 *
 * Only ever applied to text the host TYPED. A resort picked from the dropdown is
 * a catalog row that has already been through /ops, and "no resort at all" is a
 * legitimate answer — neither goes anywhere near this.
 */
export function checkResortName(input: unknown): ResortNameProblem | null {
  const value = normalizeResortName(input)
  if (!value) return { code: 'required' }

  const letters = resortNameLetterCount(value)
  if (letters === 0) return { code: 'letters' }
  if (letters < MIN_RESORT_NAME_LETTERS) return { code: 'tooShort' }
  return null
}

/** True when `checkResortName` has nothing to say — the gate on a submit button. */
export function isValidResortName(input: unknown): boolean {
  return checkResortName(input) === null
}

/**
 * The plain-English sentence the API returns as `error`. Clients that localize
 * read the problem code instead; this is what every other caller renders.
 */
export function resortNameProblemMessage(problem: ResortNameProblem): string {
  switch (problem.code) {
    case 'required':
      return 'Please type the resort or compound name'
    case 'letters':
      return 'Please write the resort or compound name in words — it can’t be only symbols or numbers'
    case 'tooShort':
      return `A resort or compound name needs at least ${MIN_RESORT_NAME_LETTERS} letters`
  }
}

/** One-shot: the message to show, or null when the name is acceptable. */
export function validateResortName(input: unknown): string | null {
  const problem = checkResortName(input)
  return problem ? resortNameProblemMessage(problem) : null
}

/**
 * The MATCH key. Case-, accent- and punctuation-insensitive, so 'Amouage',
 * 'amouage ', 'AMOUAGE' and 'Amouage.' all collide on one catalog row.
 *
 * Returns '' for input with no alphanumerics — callers must treat '' as "no
 * usable name" rather than as a real slug.
 */
export function resortSlug(name: unknown): string {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics: Café → Cafe
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ') // punctuation and non-Latin → space
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, MAX_RESORT_NAME)
}

/**
 * Levenshtein distance, iterative with a single row — enough for catalog-sized
 * lists (tens of entries), and it avoids the recursive version's blowup.
 * Used to spot typos: 'amouge' vs 'amouage' is distance 1.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[b.length]
}

export interface ResortCandidate {
  id: string
  name: string
  slug: string
}

export interface ResortSuggestion extends ResortCandidate {
  distance: number
}

/**
 * Rank catalog entries by how likely a host-typed name is a misspelling of them.
 * Powers the /ops merge dialog: when someone submits 'amouge', the admin sees
 * 'Amouage' at the top and can merge rather than creating a duplicate.
 *
 * Exact slug matches rank first (distance 0). Beyond `maxDistance` is excluded
 * entirely — suggesting a resort three edits away is noise, not help. Ties break
 * on name so the order is deterministic (and therefore testable).
 */
export function suggestResortMatches(
  typedName: unknown,
  catalog: readonly ResortCandidate[],
  { limit = 5, maxDistance = 2 }: { limit?: number; maxDistance?: number } = {}
): ResortSuggestion[] {
  const slug = resortSlug(typedName)
  if (!slug) return []

  return catalog
    .map((c) => ({ ...c, distance: editDistance(slug, c.slug) }))
    .filter((c) => c.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
}
