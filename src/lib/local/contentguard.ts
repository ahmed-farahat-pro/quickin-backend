// Content guard — keeps contact details off QuickIn's free-text surfaces, so a
// host and a guest can't take the deal (and the payment) off-platform. Enforced
// server-side on every write path, so no client can bypass it.
//
// Guarded surfaces: chat (pre-booking + booking threads), reviews, listing
// title/description, and profile name/bio. See `GuardSurface`.
//
// Guarded categories: phone numbers, email addresses, social/messaging handles,
// and external links. Each is detected AFTER a shared de-obfuscation pass, so
// the evasions people actually reach for are covered:
//
//   • separators              010 123 45 67 · 010-123-4567 · (010)/123 · 0_1_0
//   • letters as separators   A0101 S416 M3280 · 0101x416x3280 · 0a1b0c1d2e3f4g5h6
//   • chunked + trunk 0 gone  ajajx101 bsjs416 jsua3 aj2 a10 — the number in
//                             three- and four-digit pieces, each welded to a
//                             nonsense word, with the leading 0 (or 01) left
//                             for the reader to supply
//   • Arabic-Indic digits     ٠١٠١٢٣٤٥٦٧٨ and Eastern ۰۱۰
//   • fullwidth / enclosed    ０１０１２３４５６７８ · ⓪①⓪ · 0️⃣1️⃣0️⃣
//   • invisible characters    zero-width space, soft hyphen, RTL/LTR marks
//   • Cyrillic/Greek lookalikes  gmаil (Cyrillic а) · іnstagram (Cyrillic і)
//   • spelled-out (EN)        "zero one oh one two three…" · "double five"
//   • spelled-out (AR)        "صفر واحد اتنين تلاتة…"
//   • leet / homoglyphs       0l0 l234… — and OIO IZ34 when intent is stated
//   • at/dot spelling         "kareem at gmail dot com" · "kareem(at)gmail[dot]com"
//   • handles                 "@kareem_x" · "insta: kareem.x" · "add me on telegram"
//   • links                   t.me/x · wa.me/20… · bit.ly/x · "site dot com"
//   • split across messages   "010" then "1234567" then "8", or "kareem@gmail"
//                             then ".com" (checked by the caller against the
//                             sender's recent messages — see combinesIntoContact)
//
// This file is duplicated byte-for-byte in quickin-frontend so the web and the
// mobile apps enforce one policy; scripts/check-contentguard-parity.mjs fails
// the build if the copies drift. It must stay free of relative imports — that
// is what lets `test/unit/contentguard.test.mjs` load it directly.

// ── Surfaces & messages ──────────────────────────────────────────────────────

/** Where the text is going. Each surface gets its own wording on rejection. */
export type GuardSurface = 'chat' | 'review' | 'listing' | 'profile'

/** What was found. `null` when the text is clean. */
export type GuardKind = 'phone' | 'email' | 'social' | 'url'

const SURFACE_NOUN: Record<GuardSurface, string> = {
  chat: 'in chat',
  review: 'in reviews',
  listing: 'in a listing',
  profile: 'in your profile',
}

const KIND_NOUN: Record<GuardKind, string> = {
  phone: 'phone numbers',
  email: 'email addresses',
  social: 'social media or messaging handles',
  url: 'links to other sites',
}

/** The sentence shown to whoever tried to post the text. */
export function blockMessage(kind: GuardKind, surface: GuardSurface): string {
  const tail =
    surface === 'chat'
      ? 'Keep booking & payment on QuickIn.'
      : 'Keep booking & payment on QuickIn — guests will reach you here.'
  return `For your safety, sharing ${KIND_NOUN[kind]} ${SURFACE_NOUN[surface]} isn’t allowed. ${tail}`
}

/** Kept for the existing call sites and tests that import it by name. */
export const PHONE_BLOCK_MESSAGE = blockMessage('phone', 'chat')

// ── Shared de-obfuscation ────────────────────────────────────────────────────

// Invisible characters used to break up a number or a domain: zero-width
// space/non-joiner/joiner, LTR/RTL marks and embeddings, word joiner, the
// invisible maths operators, BOM, soft hyphen and the Mongolian vowel separator.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁪-⁯﻿]/g

// Cyrillic and Greek letters that render as Latin ones. Applied after
// lowercasing, so only the lowercase forms are needed.
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', с: 'c', ԁ: 'd', е: 'e', ѕ: 's', і: 'i', ј: 'j', к: 'k',
  м: 'm', н: 'h', о: 'o', р: 'p', т: 't', у: 'y', х: 'x', ц: 'u', г: 'r',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p',
  σ: 'o', τ: 't', υ: 'u', χ: 'x', ѵ: 'v',
}
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g')

/**
 * The one normalisation every detector starts from: compatibility-decompose
 * (which folds fullwidth, enclosed, superscript and presentation forms down to
 * plain ASCII/Arabic), drop combining marks (Arabic harakat, the keycap mark on
 * 0️⃣, accents used as lookalikes), drop invisible characters, lowercase, map
 * Cyrillic/Greek lookalikes to Latin, unify Arabic letter shapes, and convert
 * Arabic-Indic digits to ASCII.
 */
export function fold(input: string): string {
  let t = String(input || '')
  t = t.normalize('NFKD').replace(/\p{M}+/gu, '')
  t = t.replace(INVISIBLE, '')
  t = t.toLowerCase()
  t = t.replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
  // Arabic-Indic (U+0660–0669) and Eastern Arabic-Indic (U+06F0–06F9) digits.
  t = t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  t = t.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  // Arabic orthographic variants, so one spelling of each word is enough below.
  t = t.replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  return t
}

// ── Phone numbers ────────────────────────────────────────────────────────────

const EN_WORD: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nil: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
}
// Written against the folded form: ة→ه, ى→ي, hamza stripped from أ/إ/آ.
const AR_WORD: Array<[RegExp, string]> = [
  [/صفر/g, '0'],
  [/واحده|واحد/g, '1'],
  [/اثنين|اتنين|اثنان|تنين/g, '2'],
  [/ثلاثه|تلاته|ثلاث|تلات/g, '3'],
  [/اربعه|اربع/g, '4'],
  [/خمسه|خمس/g, '5'],
  [/سته|ست/g, '6'],
  [/سبعه|سبع/g, '7'],
  [/ثمانيه|تمانيه|ثمان|تمن/g, '8'],
  [/تسعه|تسع/g, '9'],
  [/عشره|عشر/g, '10'],
]

/** Words that signal "I am handing you my contact details" — they lower the bar
 *  on how phone-shaped a digit run has to be before it counts. */
const CONTACT_HINT =
  /(whats?\s*app|whatsapp|واتس|واتساب|telegram|تليجرام|تلجرام|signal|viber|imo|call\s*me|text\s*me|ring\s*me|dm\s*me|اتصل|كلمني|راسلني|رقمي|رقم|my\s*(number|num|no|phone|cell|mobile|line|digits)|number\s*is|reach\s*(me|out)|contact\s*me|hit\s*me\s*up|تواصل|موبايل|محمول|تليفون|هاتف|نمرتي|نمره)/i

/**
 * Fold a message to a digit-forward form: on top of `fold()`, turn spelled-out
 * numbers into digits and letters that stand in for digits back into digits.
 *
 * `aggressive` applies the o→0 / l→1 / i→1 substitution to EVERY token rather
 * than only to tokens that already contain a digit, which catches an all-letter
 * number ("OIO IZ34567"). It is only ever used together with a stated intent to
 * share contact and a strict 8-digit-run threshold, because it does turn
 * ordinary words into short digit runs ("will" → "1i11" → "111").
 */
export function normalizeForPhone(input: string, aggressive = false): string {
  let t = numberWords(input)
  // Letters standing in for digits. Restricted to tokens that already contain a
  // digit unless `aggressive`, so "hello" is untouched in the normal path.
  t = t
    .split(/(\s+)/)
    .map((tok) => {
      if (!aggressive && !/\d/.test(tok)) return tok
      const leet = tok.replace(/o/g, '0').replace(/[li|]/g, '1')
      // s→5 and z→2 only in the aggressive pass; they are strong lookalikes but
      // common enough in prose that the digit-containing pass shouldn't use them.
      return aggressive ? leet.replace(/s/g, '5').replace(/z/g, '2') : leet
    })
    .join('')
  return t
}

/**
 * Everything `normalizeForPhone` does EXCEPT the letter→digit substitution:
 * `fold()`, "double 5"/"triple 7", and the spelled-out English and Arabic
 * numbers.
 *
 * Split out because that last step is the only one that INVENTS digits out of
 * prose — "villa3" becomes "v1111a3", "pool2" becomes "p0012" — and the chunked
 * scan below stitches digit groups together across a whole phrase. Run on the
 * leeted form, "villa3 pool2 wifi6 unit10" stitches to fifteen digits that
 * happen to carry a mobile-shaped substring; run on this one it is "32610".
 * Every other caller wants the leet pass and keeps going through
 * `normalizeForPhone`.
 */
function numberWords(input: string): string {
  let t = fold(input)
  // "double 5" → 55, "triple 7" → 777.
  t = t.replace(/\b(double|triple)\s+([a-z]+|\d)\b/g, (m, mult: string, w: string) => {
    const d = /\d/.test(w) ? w : EN_WORD[w]
    if (d === undefined) return m
    return d.repeat(mult === 'double' ? 2 : 3)
  })
  // Spelled-out English number words → digits.
  t = t.replace(/\b(zero|oh|nil|nought|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => EN_WORD[w] ?? w)
  // Standalone "o" used as zero only between digits (avoid mangling words).
  t = t.replace(/(\d)\s*o\s*(?=\d)/g, '$10')
  // Spelled-out Arabic number words → digits.
  for (const [re, d] of AR_WORD) t = t.replace(re, d)
  return t
}

/** Collapse light separators (≤2 non-alphanumeric chars) sitting between
 *  digits, so "0 1 0-1 2.3 4 5 6 7 8" becomes one run. */
function collapseDigitSeparators(t: string): string {
  let s = t
  for (let i = 0; i < 12; i++) {
    const next = s.replace(/(\d)[^\p{L}\p{N}]{1,2}(\d)/gu, '$1$2')
    if (next === s) break
    s = next
  }
  return s
}

/** Every digit in `s`, in order, with everything between them dropped. Used to
 *  see through separators the collapse above won't bridge — letters, mainly. */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

/** Longest run of consecutive digits in `s`. */
function longestDigitRun(s: string): number {
  let max = 0
  let cur = 0
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') {
      cur += 1
      if (cur > max) max = cur
    } else cur = 0
  }
  return max
}

/** How forgiving one pass of the padded-digit scan below is. */
interface PaddingShape {
  /** A digit group longer than this ENDS the run rather than extending it — past
   *  that width the number is a year, a price or a size, not a chunk of a phone
   *  number. This is what keeps "90m2, 120m2, 150m2, 200m2" from joining up. */
  maxGroup: number
  /** A gap wider than this ends the run too — prose puts whole words between its
   *  numbers ("3 pools, 2 floors"), padding puts a few letters. */
  maxGap: number
  /** How many of those gaps must contain a LETTER before the run counts at all.
   *  A gap of pure punctuation is `collapseDigitSeparators`'s job, already done
   *  by the time these run. */
  minJoins: number
  /** Whether the run is held together by GLUE — letters touching the digits that
   *  follow them, with no space in between — and ENDS at the first gap that is
   *  not glue.
   *
   *  This is the line between padding and prose, and a sharper one than any
   *  length limit. Padding welds its letters to the number ("bsjs416"), so a
   *  reader’s eye slides straight off them onto the digits; prose keeps a number
   *  a word of its own ("floor 12", "area 128", "الدور 4"), because that is what
   *  makes it readable. So "ajajx101 bsjs416 jsua3" joins up, while "Villa 12,
   *  block 3, phase 2, road 9, gate 4, floor 3, unit 21" — which stitches to a
   *  perfectly mobile-shaped ten digits — never forms a run at all.
   *
   *  ENDING the run, rather than merely not counting the gap, is what the second
   *  half of that buys. "Villas 100m2 to 400m2, 3 to 6 bedrooms" has real glue in
   *  it — the `m` of each `100m2` — and if an unglued gap only failed to COUNT,
   *  those two joins would carry one run across " to " and ", " alike and stitch
   *  1002400236, which is mobile-shaped. A number stops being written the moment
   *  an ordinary word turns up in the middle of it. */
  glued: boolean
}

/** Digits wedged apart one and two at a time — "0a1b0c1d2e3f4g5h6i7j8". Every
 *  group is length one or two, so no run threshold fires, and a letter is not
 *  punctuation, so `collapseDigitSeparators` deliberately won't bridge it. */
const TIGHT_PADDING: PaddingShape = { maxGroup: 2, maxGap: 3, minJoins: 3, glued: false }

/** The same idea at the scale QA reported: the number cut into three- and
 *  four-digit CHUNKS with a short nonsense word glued to each —
 *  "ajajx101 bsjs416 jsua3 aj2 a10". Every group is too wide for TIGHT_PADDING
 *  and every gap too long, so the tight scan reads five unrelated little
 *  numbers. What a person reads is 1014163210. */
const CHUNK_PADDING: PaddingShape = { maxGroup: 4, maxGap: 8, minJoins: 2, glued: true }

/** The same scan asking for one more glued join. Used only with the nine-digit
 *  shape below, which is a weaker anchor than a whole mobile and so has to be
 *  paid for with more evidence that the text is padded at all. */
const CHUNK_PADDING_STRICT: PaddingShape = { ...CHUNK_PADDING, minJoins: 3 }

/**
 * Every run of digits in `s` that arrives in short groups with letters wedged
 * between them, returned as the digits of each run concatenated in order.
 *
 * A contiguous run is safe to reason about on its own, because three things have
 * to hold at once and honest text rarely has all three: every group is short,
 * each group is close to the next, and enough of those gaps carry a letter.
 * What the CALLER then does with the digits is where the two passes differ —
 * see `containsPhoneNumber`.
 */
function letterInterleavedRuns(s: string, shape: PaddingShape): string[] {
  const HAS_LETTER = /\p{L}/u
  const GLUED_LETTER = /\p{L}$/u // the gap's last character, i.e. touching the next digit

  const runs: string[] = []
  let digits = ''
  let joins = 0
  let prevEnd = -1 // end of the previous group, or -1 when no run is open
  const flush = () => {
    if (joins >= shape.minJoins && digits) runs.push(digits)
    digits = ''
    joins = 0
  }

  const group = /\d+/g
  let m: RegExpExecArray | null
  while ((m = group.exec(s)) !== null) {
    if (m[0].length > shape.maxGroup) {
      flush()
      prevEnd = -1
      continue
    }
    const gap = prevEnd < 0 ? null : s.slice(prevEnd, m.index)
    const isJoin =
      gap !== null &&
      gap.length <= shape.maxGap &&
      (shape.glued ? GLUED_LETTER : HAS_LETTER).test(gap)
    // A glued run ends at the first gap that isn't glue. A tight one tolerates a
    // punctuation-only gap mid-run, which is how it has always behaved.
    if (gap === null || gap.length > shape.maxGap || (shape.glued && !isJoin)) flush()
    else if (isJoin) joins += 1
    digits += m[0]
    prevEnd = m.index + m[0].length
  }
  flush()
  return runs
}

/** The digit count of the longest such run, or 0 when there is none. */
function letterInterleavedDigits(s: string, shape: PaddingShape = TIGHT_PADDING): number {
  return letterInterleavedRuns(s, shape).reduce((n, run) => Math.max(n, run.length), 0)
}

// ── Egyptian mobile shapes ───────────────────────────────────────────────────
//
// A mobile's NATIONAL SIGNIFICANT NUMBER is `1`, then the operator digit
// (0 Vodafone / 1 Etisalat / 2 Orange / 5 WE), then eight more. Everything in
// front of it — the trunk `0` a number is written with nationally, the `+20` or
// `0020` country code — is decoration, and decoration is the first thing an
// evader drops: 01014163210, 1014163210 and +201014163210 are one number, and a
// reader puts back whatever is missing without thinking about it. So the shapes
// below are written around the NSN with the prefixes optional.

const EG_MOBILE_NSN = '1[0125]\\d{8}'

/** The digits ARE a mobile: a country code and/or the trunk zero may sit in
 *  front, and nothing at all may follow. Deliberately anchored at both ends —
 *  see the note at its call site for why a substring match is not safe here. */
const EG_MOBILE_EXACT = new RegExp(`^(?:00)?(?:20)?0?${EG_MOBILE_NSN}$`)

/** The digits are a mobile with the whole `01` cut off. Nine digits behind a
 *  one-digit anchor is loose enough that it is only read off a run with an extra
 *  glued join under it — see CHUNK_PADDING_STRICT. */
const EG_MOBILE_TRIMMED = /^[0125]\d{8}$/

/** True if `text` appears to contain a phone number (after de-obfuscation). */
export function containsPhoneNumber(text: string): boolean {
  if (!text) return false
  const norm = normalizeForPhone(text)
  const compact = collapseDigitSeparators(norm)
  // The chunked scan below reads the UN-leeted form on purpose — see numberWords.
  const words = numberWords(text)
  // An 8+ digit run is a phone number (Egyptian mobile = 11, landline+area ≥ 8).
  if (longestDigitRun(compact) >= 8) return true
  // Egyptian mobile prefixes (010/011/012/015) + body.
  if (/01[0125]\d{6,8}/.test(compact)) return true
  // International country-code forms.
  if (/(?:\+|00)\s*\d[\d\s.\-]{6,}/.test(norm)) return true
  // Letters used as separators — "A0101 S416 M3280", "0101x416x3280". A letter
  // is not punctuation, so `collapseDigitSeparators` deliberately won't bridge
  // one: every group stays short and no run ever reaches 8. Reduce the whole
  // text to its digits instead, and match a phone SHAPE against that
  // concatenation — never a bare "long enough" run, which would read "built
  // 2000, 12 rooms, 34 beds, 567 sqm" as a 14-digit number. A full Egyptian
  // mobile is specific enough to survive whole-text concatenation: it needs a 0,
  // a 1, one of 0/1/2/5, then eight more digits, all consecutive.
  //
  // This also covers digits scattered through a sentence ("my number: 010, then
  // 1234, then 5678"), which is why no intent check gates it any more.
  if (/01[0125]\d{8}/.test(digitsOnly(norm))) return true
  // The same padding used on a number that ISN'T an Egyptian mobile — a Saudi
  // 05x, a ten-digit international line, a landline written without its 0. The
  // shape check above can't see those, and loosening it to a bare length would
  // have to match against the whole text. A contiguous letter-interleaved run
  // is safe to count instead: honest prose separates its numbers with whole
  // words, which never join into one run. Eight digits is the same floor a
  // plain run has to clear.
  if (letterInterleavedDigits(norm, TIGHT_PADDING) >= 8) return true
  // The number cut into CHUNKS rather than wedged apart digit by digit —
  // "ajajx101 bsjs416 jsua3 aj2 a10", which stitches to 1014163210: an Egyptian
  // mobile with only its trunk 0 left off, and a reader puts that back without
  // thinking. Nothing above sees it. Its groups are three and four digits wide,
  // so the scan on the line above ends its run at the first of them; its gaps
  // are letters, so `collapseDigitSeparators` won't bridge them; and the
  // whole-text shape match needs the leading 0 that was dropped.
  //
  // A second, more forgiving scan therefore runs over the same text, and what
  // keeps it honest is the shape it has to match: the run's digits must BE a
  // mobile from the first digit to the last, with only a country code or the
  // trunk zero allowed in front. A number written to be read has nothing else
  // in it. Matching a mobile-shaped SUBSTRING instead would block real listing
  // copy — "90m2, 120m2, 150m2, 200m2 units" stitches to 902120215022002, which
  // contains one; anchoring both ends is the whole difference.
  if (letterInterleavedRuns(words, CHUNK_PADDING).some((run) => EG_MOBILE_EXACT.test(run))) return true
  // The same chunking with the whole `01` dropped rather than just the trunk 0 —
  // "ka0 ajajx1 a4 zx1 bsjs6 mohamed3 bsjs2 q1 samir0" stitches to 014163210,
  // and a reader puts the `01` back exactly as readily. Nine digits is a weaker
  // shape than ten, so it is only read off a more thoroughly padded run.
  if (letterInterleavedRuns(words, CHUNK_PADDING_STRICT).some((run) => EG_MOBILE_TRIMMED.test(run))) return true
  if (!CONTACT_HINT.test(norm)) return false
  // From here on the sender has said they're handing over contact details, so a
  // weaker signal is enough.
  if (longestDigitRun(compact) >= 6) return true
  // A landline (area code + subscriber) interleaved the same way. Kept behind
  // the intent check, because 0[23] plus eight digits is a much likelier
  // accident in a number-heavy listing than a mobile prefix is.
  if (/0[23]\d{8}/.test(digitsOnly(norm))) return true
  // Six padded digits, for the short numbers the 8-digit floor above misses.
  if (letterInterleavedDigits(norm, TIGHT_PADDING) >= 6) return true
  // With intent stated, a chunked run no longer has to match a shape at all —
  // being long enough is sufficient, which is what catches a number written to
  // some other country's plan. Too loose to sit in front of the intent check.
  if (letterInterleavedRuns(words, CHUNK_PADDING).some((run) => run.length >= 8)) return true
  // The mobile with its trunk 0 dropped, scattered through a sentence rather
  // than chunked ("reach me on 101, then 4163, then 210").
  if (new RegExp(EG_MOBILE_NSN).test(digitsOnly(norm))) return true
  // An all-letter number written out in lookalikes ("my number is OIO IZ34567").
  if (longestDigitRun(collapseDigitSeparators(normalizeForPhone(text, true))) >= 8) return true
  return false
}

// ── Domains (shared by the email and link detectors) ─────────────────────────

// An explicit list rather than a generic `[a-z]{2,}` pattern, so "arrive at 5
// p.m. thanks" and "etc.we can talk" don't read as domains — and so a stitched
// "arrive at 5." + "come by later" doesn't read as arrive@5.come.
const TLD =
  '(?:com|net|org|edu|gov|mil|int|info|biz|name|io|co|me|app|dev|ai|link|ly|gg|tv|cc|to|sh|st|so|is|it|ee|page|bio|live|shop|store|club|fun|top|vip|pro|xyz|online|site|space|website|blog|wiki|news|media|photo|photos|pics|video|chat|social|group|team|world|life|today|one|now|run|fyi|cloud|host|press|studio|design|agency|digital|email|network|tools|zone|works|land|house|guru|ninja|rocks|cool|cash|deals|gift|art|fit|fm|am|gl|eg|sa|ae|kw|qa|bh|om|jo|lb|sy|iq|ye|ma|tn|dz|ly|sd|uk|de|fr|es|nl|be|ch|at|se|no|dk|fi|pl|cz|sk|si|hr|rs|ba|mk|al|bg|ro|hu|gr|pt|ie|lt|lv|by|ua|ru|kz|ge|am|az|md|tr|us|ca|au|nz|in|pk|bd|lk|np|cn|jp|kr|hk|tw|sg|my|id|th|ph|vn|br|mx|ar|cl|co|pe|za|ng|ke|gh|tz|ug)'

// Hosts a guest or host may legitimately paste: QuickIn itself, and a map pin
// for the property. Everything else is an off-platform link.
const ALLOWED_HOSTS = [
  /(^|\.)quickin\.app$/,
  /^quickin(-[a-z0-9-]+)?\.vercel\.app$/,
  /(^|\.)google\.com$/,
  /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2,3})?$/,
  /(^|\.)goo\.gl$/,
  /(^|\.)openstreetmap\.org$/,
]

function isAllowedHost(host: string): boolean {
  const h = host.replace(/^www\./, '').replace(/\.$/, '')
  return ALLOWED_HOSTS.some((re) => re.test(h))
}

/** Every dotted token in `t` whose last label is a real TLD, e.g.
 *  "maps.app.goo.gl" — taken whole, so a shorter prefix ("maps.app") is never
 *  mistaken for the domain and checked against the allowlist on its own. */
function extractHosts(t: string): string[] {
  const out: string[] = []
  const re = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/g
  let m: RegExpExecArray | null
  const tldOnly = new RegExp(`^${TLD}$`)
  while ((m = re.exec(t)) !== null) {
    const host = m[0]
    const last = host.slice(host.lastIndexOf('.') + 1)
    if (tldOnly.test(last)) out.push(host)
  }
  return out
}

// ── Email addresses ──────────────────────────────────────────────────────────

const MAIL_PROVIDER =
  /(gmail|googlemail|hotmail|outlook|yahoo|ymail|icloud|me\.com|proton(mail)?|live|msn|aol|yandex|mail\.ru|zoho|gmx|fastmail|tutanota|جيميل|هوتميل|ياهو)/

/**
 * Rewrite spelled-out address punctuation ("at", "dot", and their bracketed
 * forms) back to `@` and `.` so an obfuscated address matches a plain regex.
 * Run on top of `fold()`.
 */
function normalizeForEmail(input: string): string {
  let t = fold(input)
  // Bracketed markers first — unambiguous wherever they appear.
  t = t.replace(/\s*[([{<]\s*(at|@|آت|ات)\s*[)\]}>]\s*/g, '@')
  t = t.replace(/\s*[([{<]\s*(dot|d0t|\.|نقطه|نقطة)\s*[)\]}>]\s*/g, '.')
  // Bare words, only when separated — "meet at the gate" survives this because
  // the email regex below still requires a domain and a TLD.
  t = t.replace(/\s+(at|@)\s+/g, '@')
  t = t.replace(/[_\-*]{1,2}(at)[_\-*]{1,2}/g, '@')
  t = t.replace(/\s+(dot|d0t|نقطه)\s+/g, '.')
  t = t.replace(/[_\-*]{1,2}(dot)[_\-*]{1,2}/g, '.')
  t = t.replace(/\s*@\s*/g, '@')
  return t
}

/** True if `text` contains an email address, plain or spelled out. */
export function containsEmail(text: string): boolean {
  if (!text) return false
  const t = normalizeForEmail(text)
  // A full address whose domain ends in a real TLD.
  if (new RegExp(`[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\\.${TLD}\\b`).test(t)) return true
  // A handle at a known provider with the TLD left off ("kareem@gmail").
  if (new RegExp(`[a-z0-9][a-z0-9._%+-]*@\\s*${MAIL_PROVIDER.source}`).test(t)) return true
  // A provider domain sitting on its own is contact sharing in this context.
  if (new RegExp(`\\b${MAIL_PROVIDER.source}\\s*\\.\\s*(com|co\\.uk|net|ru|ae|eg)\\b`).test(t)) return true
  // "my email is kareem123" — the intent plus an identifier, no @ needed.
  if (/(e-?mail|ايميل|بريد\s*الكتروني|بريدي)/.test(t) && /[a-z][a-z0-9._-]{3,}/.test(t.replace(/\b(e-?mail|is|my|me|ايميل|بريد|الكتروني|بريدي)\b/g, ''))) {
    return true
  }
  return false
}

// ── Social / messaging handles ───────────────────────────────────────────────

const PLATFORM =
  /(instagram|insta|\big\b|snapchat|snap|telegram|\btg\b|whats?app|\bwa\.me\b|viber|\bimo\b|signal|messenger|facebook|\bfb\b|tiktok|twitter|discord|linkedin|انستجرام|انستغرام|انستا|سناب|شات|تليجرام|تلجرام|تيليجرام|واتساب|واتس|فيسبوك|فيس\s*بوك|ماسنجر|تيك\s*توك)/

/** Verbs that turn a bare platform mention into an invitation to move off-platform
 *  ("dm me on instagram"). Matched anywhere in the message. */
const MOVE_INTENT =
  /\b(add|dm|pm|msg|message|text|find|follow|reach|contact|ping|catch)\s+me\b|كلمني|راسلني|ضيفني|تابعني|دور\s*علي|ابعتلي/

/** True if `text` shares a social/messaging handle, or invites the other party
 *  onto one of those platforms. */
export function containsSocialHandle(text: string): boolean {
  if (!text) return false
  const t = fold(text)

  // A bare @handle. Two or more alphanumerics after the @, not an email (those
  // are caught by containsEmail) and not a pure number.
  const at = /(^|[^a-z0-9@._-])@([a-z0-9](?:[a-z0-9._]{2,29}))/g
  let m: RegExpExecArray | null
  while ((m = at.exec(t)) !== null) {
    const handle = m[2]
    if (/^\d+$/.test(handle)) continue
    if (/\.[a-z]{2,}$/.test(handle) && !/^[a-z0-9._]+$/.test(handle)) continue
    return true
  }

  if (!PLATFORM.test(t)) return false

  // Platform named alongside the machinery for joining it — "my whatsapp group
  // link", "telegram channel", "scan my snap QR". No handle needed: the point of
  // the sentence is to move the conversation off QuickIn.
  const JOIN = '(group|groups|channel|link|invite|join|qr|scan|جروب|قروب|لينك|رابط|جروبنا)'
  if (
    new RegExp(`${PLATFORM.source}\\s*(?:\\S+\\s+)?${JOIN}`).test(t) ||
    new RegExp(`${JOIN}\\s*(?:\\S+\\s+)?${PLATFORM.source}`).test(t)
  ) {
    return true
  }

  // Platform named, plus an identifier next to it: "insta: kareem.x",
  // "telegram = kareem_x", "my ig kareem99".
  const labelled = new RegExp(
    `${PLATFORM.source}\\s*(?:id|user(?:name)?|handle|acc(?:ount)?|:|=|-|is|هو|حسابي)?\\s*[:=]?\\s*@?([a-z0-9][a-z0-9._]{2,29})`,
  )
  const hit = labelled.exec(t)
  if (hit) {
    const candidate = hit[hit.length - 1]
    // Ignore the filler words that legitimately follow a platform name.
    if (!/^(is|the|and|for|you|your|we|our|are|can|but|not|now|use|used|have|has|here|there|please|plz|thanks|group|link|chat|call|video|number|account|acct|profile|page|بتاعي|حسابي|رقمي)$/.test(candidate)) {
      return true
    }
  }

  // Platform named with a clear "come find me there" framing but no handle yet.
  return MOVE_INTENT.test(t)
}

// ── External links ───────────────────────────────────────────────────────────

/**
 * Rewrite spelled-out dots so "site dot com" reads as a domain, then look for a
 * host with a known TLD. QuickIn's own links and a map pin are allowed through;
 * everything else is a way off the platform.
 */
export function containsExternalUrl(text: string): boolean {
  if (!text) return false
  let t = fold(text)
  t = t.replace(/\s*[([{<]\s*(dot|d0t|نقطه)\s*[)\]}>]\s*/g, '.')
  t = t.replace(/\s+(dot|d0t|نقطه)\s+/g, '.')
  t = t.replace(/\s*:\s*\/\s*\/\s*/g, '://')

  // A scheme is a link whatever the host looks like — this catches raw IPs and
  // TLDs the list below doesn't carry.
  const scheme = /\b(?:https?|ftp):\/\/([^\s/?#]+)/g
  let m: RegExpExecArray | null
  while ((m = scheme.exec(t)) !== null) {
    if (!isAllowedHost(m[1])) return true
  }

  for (const host of extractHosts(t)) {
    // An address's domain is the email detector's business, not this one.
    const at = t.indexOf('@' + host)
    if (at !== -1) continue
    if (isAllowedHost(host)) continue
    return true
  }
  return false
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export interface GuardVerdict {
  /** True when the text must not be stored. */
  blocked: boolean
  /** What was found, or null when clean. */
  kind: GuardKind | null
  /** The sentence to show the author, or null when clean. */
  message: string | null
}

const CLEAN: GuardVerdict = { blocked: false, kind: null, message: null }

/** Inspect one piece of text for every guarded category. Phone first, because
 *  it is the one people try hardest and the wording matters most. */
export function inspectContent(text: string, surface: GuardSurface = 'chat'): GuardVerdict {
  const s = String(text || '')
  if (!s.trim()) return CLEAN
  const checks: Array<[GuardKind, (t: string) => boolean]> = [
    ['phone', containsPhoneNumber],
    ['email', containsEmail],
    ['url', containsExternalUrl],
    ['social', containsSocialHandle],
  ]
  for (const [kind, fn] of checks) {
    if (fn(s)) return { blocked: true, kind, message: blockMessage(kind, surface) }
  }
  return CLEAN
}

/** Thrown by `assertNoContactInfo`. A distinct type so a route can answer 400
 *  ("you wrote something we won't store") rather than 500, without matching on
 *  the prose of the message. */
export class ContactBlockedError extends Error {
  readonly kind: GuardKind
  constructor(message: string, kind: GuardKind) {
    super(message)
    this.name = 'ContactBlockedError'
    this.kind = kind
  }
}

/** Was this thrown by the content guard? (`name` is checked too, so it still
 *  works if the module is instantiated twice in a bundle.) */
export function isContactBlockedError(err: unknown): boolean {
  return err instanceof ContactBlockedError || (err instanceof Error && err.name === 'ContactBlockedError')
}

/** Throw if `text` carries contact details. The thrown message is the one to
 *  show the author, so callers can surface `err.message` verbatim. */
export function assertNoContactInfo(text: string, surface: GuardSurface = 'chat'): void {
  const verdict = inspectContent(text, surface)
  if (verdict.blocked) throw new ContactBlockedError(verdict.message!, verdict.kind!)
}

// ── Split across messages ────────────────────────────────────────────────────

/** A "number fragment" is a message that's mostly digits with little/no prose —
 *  the tell-tale shape of a phone number being spelled out across messages
 *  ("010", "1 2 3", "double five", "٤٥"). Normal chat ("see you at 2pm",
 *  "2 guests", "room 401") is NOT a fragment, so it never accumulates. */
function isNumberFragment(text: string): boolean {
  const norm = normalizeForPhone(text)
  const digits = (norm.match(/\d/g) || []).length
  if (digits === 0) return false
  const letters = (norm.match(/[a-z؀-ۿ]/g) || []).length
  return letters <= 3
}

/**
 * Cross-message check: is the sender drip-feeding a phone number across messages
 * (one digit/chunk at a time, possibly with chatter in between)? Only acts when
 * the NEW message is itself a number fragment, then stitches together the digit
 * content of EVERY fragment in the recent window — so "0","1","0","1",… or
 * "010" / "1234567" / "8" all combine and get blocked, while legitimate stray
 * numbers (a guest count, a room number) don't.
 */
export function combinesIntoPhoneNumber(previousBodies: string[], newBody: string): boolean {
  const newNorm = normalizeForPhone(newBody)
  if (!/\d/.test(newNorm)) return false // the new message adds no digits → can't complete a number

  // Path 1 — bare number-fragments drip-fed one chunk at a time ("010","1234567","8").
  if (isNumberFragment(newBody)) {
    const fragments = [...previousBodies, newBody].filter(isNumberFragment)
    // Normalize EACH fragment first (so "zero"/"one" keep word boundaries), then
    // stitch the digit forms together and test the concatenation.
    if (fragments.length >= 2 && containsPhoneNumber(fragments.map((f) => normalizeForPhone(f)).join(' '))) {
      return true
    }
  }

  // Path 2 — digits hidden inside ordinary sentences spread across several messages,
  // but the recent window shows clear intent to share contact (a CONTACT_HINT like
  // "reach me"/"my number"/"whatsapp"). Stitch every digit across the window and look
  // for a phone-SHAPED number — not just any long run — so order/tracking/booking
  // numbers stated in passing don't false-positive.
  const windowNorm = normalizeForPhone([...previousBodies, newBody].join('  '))
  if (CONTACT_HINT.test(windowNorm)) {
    const digits = collapseDigitSeparators(windowNorm).replace(/\D/g, '')
    // The trunk 0 is optional here for the same reason it is optional everywhere
    // else: a reader supplies it. Safe to loosen behind the intent check above.
    if (new RegExp(EG_MOBILE_NSN).test(digits)) return true // Egyptian mobile split across messages
    if (/(?:\+|00)\s*\d[\d\s.\-]{7,}/.test(windowNorm)) return true // international form anywhere in the window
  }
  return false
}

/**
 * An address or link split over two messages ("kareem@gmail" then ".com",
 * "insta" then "kareem_x"). Only the immediately preceding message is joined to
 * the new one, and only when the new one is a short fragment — joining a whole
 * window would invent domains out of ordinary sentences ("arrive at 5." +
 * "come by later").
 */
function completesContactWithPrevious(previousBodies: string[], newBody: string): boolean {
  const prev = previousBodies[previousBodies.length - 1]
  if (!prev) return false
  const fragment = String(newBody || '').trim()
  if (!fragment || fragment.length > 30 || fragment.split(/\s+/).length > 3) return false
  // Already-clean halves only: if either half is blocked on its own the caller
  // has rejected it, and re-reporting it here would be noise.
  for (const joined of [String(prev).trim() + fragment, String(prev).trim() + ' ' + fragment]) {
    if (containsEmail(joined) || containsExternalUrl(joined) || containsSocialHandle(joined)) return true
  }
  return false
}

/**
 * The full cross-message check the write paths use: a phone number drip-fed
 * across the sender's recent messages, or an address/link/handle completed by
 * this one. `previousBodies` is oldest-first and should be the sender's own
 * recent messages in the same thread.
 */
export function combinesIntoContact(previousBodies: string[], newBody: string, surface: GuardSurface = 'chat'): GuardVerdict {
  if (combinesIntoPhoneNumber(previousBodies, newBody)) {
    return { blocked: true, kind: 'phone', message: blockMessage('phone', surface) }
  }
  if (completesContactWithPrevious(previousBodies, newBody)) {
    return { blocked: true, kind: 'email', message: blockMessage('email', surface) }
  }
  return CLEAN
}
