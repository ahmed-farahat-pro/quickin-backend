// Unit tests for src/lib/local/password-policy.ts — the strength rules every path
// that sets a password clears (/api/auth/signup, /api/auth/reset-password and
// /api/local/change-password here; signup, reset and change on the web, whose
// copy of the module this one is kept byte-identical to).
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. password-policy.ts has no imports, which is what makes it
// loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULE_IDS,
  checkPassword,
  isStrongPassword,
  passwordProblemMessage,
  passwordRuleStatus,
  validatePassword,
} from '../../src/lib/local/password-policy.ts'

// One password that satisfies every rule, reused as the control.
const STRONG = 'Nile-Sunset-42'

describe('checkPassword — the bug this policy exists for', () => {
  test('the weak passwords signup used to accept are refused', () => {
    // Every one of these created an account under the old six-character rule.
    for (const weak of ['123456', 'password', 'qwerty', 'abc123', 'aaaaaa', '111111']) {
      assert.notEqual(checkPassword(weak), null, `${weak} must be refused`)
    }
  })

  test('a password that meets every rule is accepted', () => {
    assert.equal(checkPassword(STRONG), null)
    assert.equal(checkPassword('m3lokhia!Cairo'), null)
    assert.equal(isStrongPassword(STRONG), true)
  })
})

describe('checkPassword — the rules, one at a time', () => {
  test('reports the FIRST unmet rule, in checklist order', () => {
    // The message a guest sees has to match the box they see unticked.
    assert.equal(checkPassword('Aa1!')?.code, 'length')
    assert.equal(checkPassword('nile-sunset-42')?.code, 'uppercase')
    assert.equal(checkPassword('NILE-SUNSET-42')?.code, 'lowercase')
    assert.equal(checkPassword('Nile-Sunset-Bay')?.code, 'digit')
    assert.equal(checkPassword('NileSunset42')?.code, 'symbol')
  })

  test('length counts characters, not UTF-16 units', () => {
    // Seven characters plus an emoji is eight to the person who typed it.
    assert.equal(checkPassword('Ab1!xyz🌅')?.code ?? null, null)
    assert.equal(checkPassword('Ab1!xy🌅')?.code, 'length')
  })

  test('Arabic-Indic digits are digits', () => {
    assert.equal(checkPassword('Nile-Sunset-٤٢'), null)
  })

  test('a space does not count as the symbol', () => {
    // Otherwise "Abcdefg 1" would pass on a space bar press.
    assert.equal(checkPassword('Abcdefg 1')?.code, 'symbol')
  })

  test('an empty value is `required`, not a rule failure', () => {
    assert.equal(checkPassword('')?.code, 'required')
    assert.equal(checkPassword(undefined)?.code, 'required')
    assert.equal(checkPassword(null)?.code, 'required')
  })

  test('only-spaces is called out for what it is', () => {
    assert.equal(checkPassword('            ')?.code, 'whitespace')
  })

  test('caps the length so hashing stays bounded', () => {
    assert.equal(checkPassword(`Aa1!${'x'.repeat(MAX_PASSWORD_LENGTH)}`)?.code, 'tooLong')
    assert.equal(checkPassword(`Aa1!${'x'.repeat(MAX_PASSWORD_LENGTH - 4)}`), null)
  })
})

describe('checkPassword — the account email', () => {
  test('refuses the address itself, in any case', () => {
    // This one clears every character rule, which is exactly why the check exists.
    assert.equal(checkPassword('Layla2004@email.com', 'layla2004@email.com')?.code, 'email')
    assert.equal(checkPassword('Layla2004@Email.Com', 'layla2004@email.com')?.code, 'email')
  })

  test('refuses a local part long enough to stand alone', () => {
    assert.equal(checkPassword('Layla-2004', 'layla-2004@email.com')?.code, 'email')
  })

  test('a short local part is not a banned password on its own', () => {
    // The rule must not reject an unrelated password that happens to contain a
    // three-letter name.
    assert.equal(checkPassword('Amr-and-more-42', 'amr@email.com'), null)
  })

  test('with no email known, only the generic rules apply', () => {
    assert.equal(checkPassword('Layla2004@email.com'), null)
  })
})

describe('checkPassword — common passwords', () => {
  test('the classic top-of-the-list guesses, however decorated', () => {
    // Each of these clears length, case, digit and symbol — the blocklist is the
    // only thing standing between them and an account.
    for (const guess of ['Password1!', 'P@ssw0rd123', 'Welcome2024!', 'Qwerty123!', 'Iloveyou1!']) {
      assert.equal(checkPassword(guess)?.code, 'common', `${guess} must be refused`)
    }
  })

  test('the product name is not a password', () => {
    assert.equal(checkPassword('Quickin2026!')?.code, 'common')
  })

  test('a common word inside a real password is fine', () => {
    // Refusing everything that contains "cairo" would be a support ticket, not
    // a security win.
    assert.equal(checkPassword('Cairo-Nights-42!'), null)
    assert.equal(checkPassword('Sunshine-On-The-Nile-9!'), null)
  })
})

describe('passwordRuleStatus — what the form draws', () => {
  test('returns every rule, in checklist order, with its state', () => {
    const status = passwordRuleStatus('nile')
    assert.deepEqual(status.map((r) => r.id), [...PASSWORD_RULE_IDS])
    assert.deepEqual(
      status.map((r) => r.met),
      [false, false, true, false, false]
    )
  })

  test('every rule ticks for a password checkPassword accepts', () => {
    assert.ok(passwordRuleStatus(STRONG).every((r) => r.met))
  })

  test('survives a value that isn\'t a string', () => {
    assert.equal(passwordRuleStatus(undefined).every((r) => !r.met), true)
  })
})

describe('messages', () => {
  test('every problem code has a sentence — no code falls through', () => {
    const codes = [...PASSWORD_RULE_IDS, 'required', 'tooLong', 'whitespace', 'email', 'common']
    for (const code of codes) {
      const message = passwordProblemMessage({ code })
      assert.equal(typeof message, 'string')
      assert.ok(message.length > 0, `${code} has no message`)
    }
  })

  test('the length message names the floor the form advertises', () => {
    assert.match(String(validatePassword('Aa1!')), new RegExp(`at least ${MIN_PASSWORD_LENGTH}`))
  })

  test('validatePassword is null for an acceptable password', () => {
    assert.equal(validatePassword(STRONG, 'layla@email.com'), null)
  })
})
