// Content guard — blocks sharing phone numbers in chat by ANY trick. QuickIn
// keeps contact off-platform: a host must never pass a phone number to a guest
// (or vice-versa). Enforced server-side so no client can bypass it.
//
// Tricks handled:
//   • plain digits            01012345678
//   • separators              010 123 45 67 · 010-123-4567 · 010.123.4567 · (010)/123
//   • Arabic-Indic digits     ٠١٠١٢٣٤٥٦٧٨ and Eastern ۰۱۰
//   • spelled-out (EN)        "zero one oh one two three…" · "double five" · "oh"
//   • spelled-out (AR)        "صفر واحد اتنين تلاتة…"
//   • leet / homoglyphs       0l0 l234… (o→0, l/i→1) inside number-ish tokens
//   • contact-app + number    "whatsapp 010…", "واتس ٠١٠…", "call me 010…"
//   • split across messages   "010" then "1234567" then "8" (checked by the caller
//                             against the sender's recent messages)

const EN_WORD: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nil: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
}
const AR_WORD: Array<[RegExp, string]> = [
  [/صفر/g, '0'], [/واحد|واحده|واحدة/g, '1'], [/اثنين|اتنين|اثنان/g, '2'],
  [/ثلاثة|تلاتة|ثلاث/g, '3'], [/اربعة|أربعة|اربع|أربع/g, '4'], [/خمسة|خمس/g, '5'],
  [/ستة|ست/g, '6'], [/سبعة|سبع/g, '7'], [/ثمانية|تمانية|ثمان/g, '8'],
  [/تسعة|تسع/g, '9'], [/عشرة|عشره/g, '10'],
]
const CONTACT_HINT = /(whats?\s*app|whatsapp|واتس|واتساب|telegram|تليجرام|تلجرام|signal|viber|imo|call\s*me|اتصل|كلمني|رقمي|رقم|my\s*(number|num|phone|cell|mobile|digits)|number\s*is|reach\s*me|تواصل|موبايل|تليفون|هاتف)/i

/** Fold a message to a digit-forward form: Arabic digits → ASCII, spelled
 *  numbers → digits, and leet chars → digits inside number-ish tokens. */
export function normalizeForPhone(input: string): string {
  let t = (input || '').toLowerCase()
  // Arabic-Indic (U+0660–0669) and Eastern Arabic-Indic (U+06F0–06F9) digits.
  t = t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  t = t.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  // "double 5" → 55, "triple 7" → 777.
  t = t.replace(/\b(double|triple)\s+([a-z]+|\d)\b/g, (m, mult: string, w: string) => {
    const d = /\d/.test(w) ? w : EN_WORD[w]
    if (d === undefined) return m
    return d.repeat(mult === 'double' ? 2 : 3)
  })
  // Spelled-out English number words → digits.
  t = t.replace(/\b(zero|oh|nil|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => EN_WORD[w] ?? w)
  // Standalone "o" used as zero only between digits (avoid mangling words).
  t = t.replace(/(\d)\s*o\s*(?=\d)/g, '$10')
  // Spelled-out Arabic number words → digits.
  for (const [re, d] of AR_WORD) t = t.replace(re, d)
  // Leet only inside tokens that already contain a digit (so "hello" is untouched).
  t = t
    .split(/(\s+)/)
    .map((tok) => (/\d/.test(tok) ? tok.replace(/[oO]/g, '0').replace(/[lLiI|]/g, '1') : tok))
    .join('')
  return t
}

/** Collapse light separators (≤2 chars) sitting between digits, so
 *  "0 1 0-1 2.3 4 5 6 7 8" becomes one run. */
function collapseDigitSeparators(t: string): string {
  let s = t
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/(\d)[\s.\-()+/\\_*~,]{1,2}(\d)/g, '$1$2')
    if (next === s) break
    s = next
  }
  return s
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

/** True if `text` appears to contain a phone number (after de-obfuscation). */
export function containsPhoneNumber(text: string): boolean {
  if (!text) return false
  const norm = normalizeForPhone(text)
  const compact = collapseDigitSeparators(norm)
  // An 8+ digit run is a phone number (Egyptian mobile = 11, landline+area ≥ 8).
  if (longestDigitRun(compact) >= 8) return true
  // Egyptian mobile prefixes (010/011/012/015) + body.
  if (/01[0125]\d{6,8}/.test(compact)) return true
  // International country-code forms.
  if (/(?:\+|00)\s*\d[\d\s.\-]{6,}/.test(norm)) return true
  // A contact-app/"my number" hint plus a 6+ digit run lowers the bar.
  if (CONTACT_HINT.test(norm) && longestDigitRun(compact) >= 6) return true
  return false
}

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

/** Cross-message check: is the sender drip-feeding a phone number across messages
 *  (one digit/chunk at a time, possibly with chatter in between)? Only acts when
 *  the NEW message is itself a number fragment, then stitches together the digit
 *  content of EVERY fragment in the recent window — so "0","1","0","1",… or
 *  "010" / "1234567" / "8" all combine and get blocked, while legitimate stray
 *  numbers (a guest count, a room number) don't. */
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
    if (/01[0125]\d{8}/.test(digits)) return true // Egyptian mobile (11 digits) split across messages
    if (/(?:\+|00)\s*\d[\d\s.\-]{7,}/.test(windowNorm)) return true // international form anywhere in the window
  }
  return false
}

export const PHONE_BLOCK_MESSAGE =
  'For your safety, sharing phone numbers in chat isn’t allowed. Keep booking & payment on QuickIn.'
