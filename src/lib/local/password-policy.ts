// =============================================================================
// PASSWORD POLICY — the one place that decides whether a password is strong
// =============================================================================
// Pure logic, no imports, so the same code runs in the API routes, in the client
// forms, and under `node --test`. Keep it that way — see README → Testing.
//
// Signup used to ask for six characters of anything, so `123456` created a real
// account with a real booking history behind it. The rules below are the whole
// policy; every path that sets a password (signup, reset, change) calls
// `checkPassword`, because a floor only one of the three enforces is not a floor.
//
// One deliberate limitation: `uppercase` and `lowercase` can only be met by a
// script that has case. A password written purely in Arabic script cannot pass —
// the checklist on the form says so up front rather than failing on submit.
// =============================================================================

/** The floor. Eight is the shortest length the character rules below make useful. */
export const MIN_PASSWORD_LENGTH = 8

/** Long enough for any passphrase, short enough that hashing stays bounded. */
export const MAX_PASSWORD_LENGTH = 128

/** The rules a form renders as a live checklist, in the order they are shown. */
export type PasswordRuleId = 'length' | 'uppercase' | 'lowercase' | 'digit' | 'symbol'

export const PASSWORD_RULE_IDS: readonly PasswordRuleId[] = [
  'length',
  'uppercase',
  'lowercase',
  'digit',
  'symbol',
] as const

/**
 * Why a password was refused. Rule codes double as checklist ids; the rest are
 * the checks that can't be drawn as a tick-box.
 *
 * Structured like `EmailProblem` in email-core.ts and for the same reason: the
 * API echoes the code so a client can localize the reason without re-deciding it.
 */
export type PasswordProblemCode = PasswordRuleId | 'required' | 'tooLong' | 'whitespace' | 'email' | 'common'

export interface PasswordProblem {
  code: PasswordProblemCode
}

// Unicode-aware on purpose: `\p{Nd}` accepts Arabic-Indic digits (٤٢), which are
// digits to every guest who types them. A symbol is anything that is neither a
// letter nor a number — minus whitespace, or a single space would satisfy it.
const HAS_UPPERCASE = /\p{Lu}/u
const HAS_LOWERCASE = /\p{Ll}/u
const HAS_DIGIT = /\p{Nd}/u
const HAS_SYMBOL = /[^\p{L}\p{N}\s]/u

/** Is this one rule satisfied? Exported through `passwordRuleStatus` for the UI. */
function meetsRule(rule: PasswordRuleId, password: string): boolean {
  switch (rule) {
    case 'length':
      // Code points, not UTF-16 units: an emoji is one character to the person
      // who typed it, and counting it as two would let a 7-character password in.
      return [...password].length >= MIN_PASSWORD_LENGTH
    case 'uppercase':
      return HAS_UPPERCASE.test(password)
    case 'lowercase':
      return HAS_LOWERCASE.test(password)
    case 'digit':
      return HAS_DIGIT.test(password)
    case 'symbol':
      return HAS_SYMBOL.test(password)
  }
}

/**
 * The most-guessed passwords, as *bases* — the comparison strips the decoration
 * people add to get past exactly this kind of rule (`P@ssw0rd!23` → `password`).
 * Short by design: this is a speed bump for the top of every cracking list, not a
 * dictionary. A long list would start refusing passwords that merely contain a
 * common word, which is a support ticket, not a security win.
 */
const COMMON_PASSWORD_BASES = new Set([
  'password', 'passwd', 'pass', 'letmein', 'welcome', 'admin', 'administrator',
  'qwerty', 'qwertyuiop', 'qwertz', 'azerty', 'qazwsx', 'zaqwsx',
  'abc', 'abcd', 'abcde', 'abcdef', 'test', 'testing', 'demo', 'guest', 'login',
  'iloveyou', 'sunshine', 'princess', 'superman', 'batman', 'monkey', 'dragon',
  'shadow', 'master', 'freedom', 'whatever', 'trustno', 'starwars', 'football',
  'baseball', 'basketball', 'michael', 'ashley', 'jordan', 'jessica',
  'quickin', 'booking', 'holiday', 'vacation', 'egypt', 'cairo', 'alexandria',
])

// Leetspeak is a substitution, not a secret. Undo the common ones before the
// blocklist lookup so `P@$$w0rd` and `password` are the same guess.
const LEET: Record<string, string> = {
  '@': 'a', '4': 'a', '8': 'b', '(': 'c', '3': 'e', '6': 'g', '1': 'i', '!': 'i',
  '|': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '2': 'z',
}

function unleet(value: string): string {
  return value.replace(/[@48(361!|05$7+2]/g, (ch) => LEET[ch] ?? ch).replace(/[^a-z]/g, '')
}

/**
 * The guesses behind a password. Two readings, because the decoration people add
 * lives at both ends: `Password1!` is the base plus a suffix (shed the trailing
 * run of non-letters *first*), while `P@ssw0rd` is the base with substitutions
 * inside it (un-leet, don't shed). Trying both catches `P@ssw0rd123`.
 */
function commonPasswordBases(password: string): string[] {
  const lowered = password.toLowerCase()
  return [unleet(lowered.replace(/[^a-z]+$/, '')), unleet(lowered)]
}

function isCommonPassword(password: string): boolean {
  for (const base of commonPasswordBases(password)) {
    if (!base) continue
    if (COMMON_PASSWORD_BASES.has(base)) return true
    // A repeated base (`abcabcabc`) is the same guess typed three times.
    const repeated = /^(.+?)\1+$/.exec(base)
    if (repeated && COMMON_PASSWORD_BASES.has(repeated[1])) return true
  }
  return false
}

/** Lower-cased and trimmed — the shape every users / otp_codes lookup keys on. */
function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase()
}

/**
 * Decide a password. Returns the first problem, or null when it is acceptable.
 *
 * `email` is optional and only tightens the result: an account's own address is
 * at the top of every credential-stuffing list, and a reset is exactly where
 * people reach for the most guessable thing they can remember.
 */
export function checkPassword(password: unknown, email?: string): PasswordProblem | null {
  const value = String(password ?? '')
  if (!value) return { code: 'required' }
  if (value.length > MAX_PASSWORD_LENGTH) return { code: 'tooLong' }
  if (!value.trim()) return { code: 'whitespace' }

  for (const rule of PASSWORD_RULE_IDS) {
    if (!meetsRule(rule, value)) return { code: rule }
  }

  const account = normalizeEmail(email)
  if (account) {
    const lowered = value.toLowerCase()
    const localPart = account.split('@')[0]
    if (lowered === account || (localPart.length >= MIN_PASSWORD_LENGTH && lowered === localPart)) {
      return { code: 'email' }
    }
  }

  if (isCommonPassword(value)) return { code: 'common' }
  return null
}

/** True when `checkPassword` has nothing to say — the gate on a submit button. */
export function isStrongPassword(password: unknown, email?: string): boolean {
  return checkPassword(password, email) === null
}

/**
 * Per-rule state for the checklist under the field. Only the tick-box rules —
 * `email` and `common` are verdicts on submit, not things to aim at while typing.
 */
export function passwordRuleStatus(password: unknown): { id: PasswordRuleId; met: boolean }[] {
  const value = String(password ?? '')
  return PASSWORD_RULE_IDS.map((id) => ({ id, met: meetsRule(id, value) }))
}

/**
 * The plain-English sentence the API returns as `error`. Clients that localize
 * read `passwordProblem.code` instead; this is what every other caller renders.
 */
export function passwordProblemMessage(problem: PasswordProblem): string {
  switch (problem.code) {
    case 'required':
      return 'Password is required'
    case 'tooLong':
      return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
    case 'whitespace':
      return 'Password cannot be only spaces'
    case 'length':
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    case 'uppercase':
      return 'Password must contain an uppercase letter'
    case 'lowercase':
      return 'Password must contain a lowercase letter'
    case 'digit':
      return 'Password must contain a number'
    case 'symbol':
      return 'Password must contain a symbol (for example ! ? @ #)'
    case 'email':
      return 'Password cannot be your email address'
    case 'common':
      return 'That password is too common. Please choose a less guessable one.'
  }
}

/** One-shot: the message to show, or null when the password is acceptable. */
export function validatePassword(password: unknown, email?: string): string | null {
  const problem = checkPassword(password, email)
  return problem ? passwordProblemMessage(problem) : null
}
