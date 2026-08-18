// Phone numbers — the one rule for "is this a phone number?", and the one
// canonical form we store.
//
// A phone number is how our team reaches an applicant; a field that took
// anything a keyboard produces let `asdf` through to review, where the only
// signal it was wrong came from a human trying to dial it. Every surface that
// takes a phone number runs this module — the web form, the web API and the
// mobile API — so all three agree on the answer and on what gets stored.
//
// It normalizes as well as validates, on the same reasoning as the payout
// wallet number: the same Egyptian mobile typed as `+20 10…`, `0020 10…` or
// `010…` is one number, and storing it three ways makes one applicant look like
// three. Egyptian mobiles come back in the local `01XXXXXXXXX` form everyone
// here reads; anything else keeps `+<digits>` E.164, because a host abroad still
// has to be reachable.
//
// Rejection is deliberately a `null` rather than a throw — every caller is
// building a per-field error map, and the message belongs to the caller (the web
// form's is localized, the API's is not).
//
// No runtime imports, so `node --test` can import this file directly — see
// README → Testing. Callers import the core, never the reverse.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// write the same `host_applications.phone`. A number the web stored as
// `01012345678` and the apps stored as `+201012345678` is one host filed twice,
// so this file must be byte-identical, not merely equivalent.
// quickin-backend/scripts/check-phone-core-parity.mjs fails if they drift.

/** Longest input accepted before normalizing. E.164 caps a number at 15 digits;
 *  the rest of the room is for the spaces, brackets and dashes people type. */
export const MAX_PHONE_CHARS = 24

/** Fewest / most digits any international number has (ITU-T E.164). */
export const MIN_PHONE_DIGITS = 8
export const MAX_PHONE_DIGITS = 15

/** The characters a written phone number is made of — digits, a leading `+`,
 *  and the separators printed on business cards. A letter is not one of them. */
const PHONE_SHAPE = /^\+?[\d\s().-]+$/

/**
 * Arabic-Indic and Persian digits folded to ASCII. The site runs in Arabic and
 * an Arabic keyboard types ٠١٠…; those are digits, and a filter that dropped
 * them would empty the field of a host typing their own number correctly.
 */
export function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) =>
    String((d.codePointAt(0) as number) & 0xf)
  )
}

/**
 * The canonical form of `v`, or `null` when it is not a phone number.
 *
 * `null` covers every rejection — letters, an empty field, too few or too many
 * digits — because the caller's field error says "that isn't a phone number"
 * either way and a user does not act differently on the reason.
 */
export function normalizePhone(v: unknown): string | null {
  const raw = toAsciiDigits(String(v ?? '').trim())
  if (!raw || raw.length > MAX_PHONE_CHARS) return null
  if (!PHONE_SHAPE.test(raw)) return null

  // `+20…` and `0020…` are the same country code written two ways.
  const digits = raw.replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, '')
  if (!/^\d+$/.test(digits)) return null

  // Egypt, written either way: `20…` is the country code (the only assigned one
  // starting with 20 — Morocco is 212, Libya 218), a leading 0 is the trunk
  // prefix. Both are read back in the local form everyone here dials.
  const local = digits.startsWith('20')
    ? `0${digits.slice(2)}`
    : digits.startsWith('0')
      ? digits
      : null
  if (local !== null) {
    // A mobile is 01 + 9 digits, exactly. Length is checked rather than assumed
    // so `0101234567` — a real number with a digit missed — is caught here and
    // not by the person trying to call it.
    if (local.startsWith('01')) return /^01\d{9}$/.test(local) ? local : null
    // A landline: trunk 0, a 1–2 digit area code, then the subscriber number.
    return /^0[2-9]\d{6,9}$/.test(local) ? local : null
  }

  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null
  return `+${digits}`
}

/** True when `v` is a phone number we would store. */
export function isValidPhone(v: unknown): boolean {
  return normalizePhone(v) !== null
}

/**
 * What a phone field should hold after a keystroke: the typed text with anything
 * that is not part of a phone number dropped.
 *
 * This runs on every change so a letter never appears in the field at all —
 * quieter than typing a word and being told about it on submit. It only filters;
 * `normalizePhone` still decides whether what is left is a real number, since
 * `+++` survives this and is not a phone number.
 */
export function filterPhoneInput(v: string): string {
  const s = toAsciiDigits(v)
  // A `+` is only a `+` at the front — mid-number it is noise.
  const plus = s.trimStart().startsWith('+') ? '+' : ''
  return (plus + s.replace(/[^\d\s().-]/g, '').trimStart()).slice(0, MAX_PHONE_CHARS)
}
