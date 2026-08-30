/**
 * Which profile fields a PATCH body actually submitted, and whether each one was
 * SET or CLEARED. No imports, so `node --test` can load it — see README → Testing.
 *
 * ## The bug this exists to fix: absent is not the same as cleared
 *
 * `updateProfile` wrote every column as `COALESCE($n, col)`, which reads SQL NULL
 * as "leave this alone". Both mobile apps, meanwhile, send an explicit `null` to
 * mean "I removed this" — iOS says so in as many words ("explicit null when
 * removed"), and Android sends `JSONObject.NULL`. The two halves disagreed and
 * the SQL won: **removing your profile photo or clearing your bio silently did
 * nothing, on every client.** The web account page had the same intent and the
 * same outcome.
 *
 * A value cannot carry that distinction, because the value for "cleared" is the
 * same shape as the value for "not mentioned". Only the PRESENCE OF THE KEY can:
 *
 *   - key absent          → `absent`  → leave the column alone
 *   - key present, blank  → `cleared` → write SQL NULL
 *   - key present, value  → `set`     → write it
 *
 * ## Why blank covers both null and ''
 *
 * The clients disagree about which one they send for a field someone emptied:
 * iOS nulls a cleared bio, Android trims it to `''`, and the web form posts `''`.
 * Treating only one of them as the clear would fix the bug on one platform and
 * leave it on the others, so both land on NULL — and one absent bio then looks
 * like every other absent bio in the column.
 *
 * The blank test is spelled out here rather than borrowed from `profile-core`'s
 * `isBlankField` because this module must stay import-free to remain testable.
 * It is the same rule: nothing but invisibles and whitespace.
 */

/** Fields `PATCH /api/local/profile` can write, named as the API spells them. */
export type ProfileFieldName = 'full_name' | 'age' | 'phone' | 'bio' | 'avatar_url' | 'country'

/**
 * Every spelling of each field that is in the wild. Older Android builds send
 * `fullName`, some clients send `avatarUrl`, and `Age` has been seen capitalised.
 * A field counts as submitted under any of them; the first one present wins.
 */
export const FIELD_SPELLINGS: Record<ProfileFieldName, readonly string[]> = {
  full_name: ['full_name', 'fullName'],
  age: ['age', 'Age'],
  phone: ['phone'],
  bio: ['bio'],
  avatar_url: ['avatar_url', 'avatarUrl'],
  country: ['country'],
}

export type Submission =
  | { kind: 'absent' }
  | { kind: 'cleared' }
  | { kind: 'set'; value: unknown }

/** Zero-width and other invisibles that must not make a blank field look filled. */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu

/** True when a submitted value means "remove this" — null, '', or only spacing. */
export function isClearedValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'number' || typeof v === 'boolean') return false
  return String(v).replace(INVISIBLE, '').trim() === ''
}

/** True when `body` is a plain object we can read keys off. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Classify one field of a PATCH body as absent, cleared, or set. */
export function readProfileField(body: unknown, field: ProfileFieldName): Submission {
  if (!isRecord(body)) return { kind: 'absent' }
  for (const key of FIELD_SPELLINGS[field]) {
    // hasOwnProperty, not `in`: `in` walks the prototype chain, so a body whose
    // prototype happened to carry one of these names would count as having
    // submitted it — and submitting is the whole basis for writing the column.
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue
    const value = body[key]
    return isClearedValue(value) ? { kind: 'cleared' } : { kind: 'set', value }
  }
  return { kind: 'absent' }
}

/** Classify every writable field of a PATCH body in one pass. */
export function readProfilePatch(body: unknown): Record<ProfileFieldName, Submission> {
  return {
    full_name: readProfileField(body, 'full_name'),
    age: readProfileField(body, 'age'),
    phone: readProfileField(body, 'phone'),
    bio: readProfileField(body, 'bio'),
    avatar_url: readProfileField(body, 'avatar_url'),
    country: readProfileField(body, 'country'),
  }
}

/**
 * The widest an `avatar_url` may be, in characters.
 *
 * Avatars arrive two ways and both are legal: a `data:` URL the picker downscaled
 * in the browser, and an `https://` URL from a Google sign-in or from Blob
 * storage. There is no shape check that accepts both, so the guard is a size cap —
 * the column rides along with a user row read on every request, and an unbounded
 * string in it is the actual hazard. 400k chars is ~300KB decoded, well above the
 * ~15KB the pickers produce and well below anything that would bloat the row.
 */
export const MAX_AVATAR_URL_CHARS = 400_000
