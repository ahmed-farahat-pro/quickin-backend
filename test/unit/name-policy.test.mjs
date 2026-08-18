// Unit tests for src/lib/local/name-policy.ts — the rule every path that sets a
// display name clears (both /api/auth/signup routes, `signUpSchema`, the /signup
// form, the host application, and the iOS `NameRules` twin).
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. name-policy.ts has no imports, which is what makes it
// loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_NAME_LENGTH,
  MIN_NAME_LETTERS,
  checkName,
  fallbackNameFromEmail,
  isValidName,
  nameProblemMessage,
  normalizeName,
  validateName,
} from '../../src/lib/local/name-policy.ts'

describe('checkName — the bug this policy exists for', () => {
  test('a numeric-only name is refused', () => {
    // Every one of these created an account whose display name a host would read
    // next to a booking request.
    for (const digits of ['12345', '0', '007', '0100', '1234567890', '42 42']) {
      assert.equal(checkName(digits)?.code, 'letters', `${digits} must be refused`)
    }
  })

  test('Arabic-Indic and other non-Latin digits are digits too', () => {
    // ٠١٢٣ is `0123` to the guest who typed it — a name-shaped hole otherwise.
    assert.equal(checkName('٠١٢٣٤')?.code, 'letters')
    assert.equal(checkName('۰۱۲۳۴')?.code, 'letters')
    assert.equal(checkName('０１２３４')?.code, 'letters')
  })

  test('punctuation-only and symbol-only names are refused for the same reason', () => {
    for (const junk of ['-----', '...', '???', '@@@', '🌅🌅']) {
      assert.equal(checkName(junk)?.code, 'letters', `${junk} must be refused`)
    }
  })
})

describe('checkName — the names that must still get in', () => {
  test('ordinary names in every script this app serves', () => {
    for (const name of [
      'Layla Hassan',
      'Ali M',
      'Bo',
      'محمد أحمد',
      'ليلى',
      'Jean-Luc Picard',
      "O'Brien",
      'Anne-Marie de la Cruz',
      'José Ángel Núñez',
      '李伟',
      'Иван Петров',
    ]) {
      assert.equal(checkName(name), null, `${name} must be accepted`)
      assert.equal(isValidName(name), true)
    }
  })

  test('Franco-Arabic names keep their numerals', () => {
    // Egyptians write real names with digits standing in for Arabic letters.
    // A "no digits in names" rule would turn away exactly this app's guests.
    for (const name of ['Ma7moud', '3omar Hassan', 'Sha2wa', '7assan 3ly']) {
      assert.equal(checkName(name), null, `${name} must be accepted`)
    }
  })
})

describe('checkName — the rest of the rules', () => {
  test('an empty or whitespace-only name is `required`, not `letters`', () => {
    for (const empty of ['', '   ', '\t\n', null, undefined]) {
      assert.equal(checkName(empty)?.code, 'required')
    }
  })

  test('invisible characters do not make a name non-empty', () => {
    // A pasted zero-width space survives .trim() and would otherwise read as a
    // one-character name.
    assert.equal(checkName('​​')?.code, 'required')
    assert.equal(checkName('﻿')?.code, 'required')
    // …and they do not count towards the letters either.
    assert.equal(checkName('A​')?.code, 'tooShort')
  })

  test('a single letter is `tooShort` — with digits it is still too short', () => {
    assert.equal(checkName('A')?.code, 'tooShort')
    assert.equal(checkName('A1')?.code, 'tooShort')
    assert.equal(checkName('J.')?.code, 'tooShort')
    assert.equal(MIN_NAME_LETTERS, 2)
  })

  test('`letters` is reported before `tooShort`, so `5` hears the real problem', () => {
    // Both rules fail for `5`; telling a guest to add a second character would
    // send them to `55`, which is refused for a reason they were never told.
    assert.equal(checkName('5')?.code, 'letters')
  })

  test('length is measured in characters, not UTF-16 units', () => {
    assert.equal(checkName('م'.repeat(MAX_NAME_LENGTH)), null)
    assert.equal(checkName('م'.repeat(MAX_NAME_LENGTH + 1))?.code, 'tooLong')
    // An emoji is one character to whoever typed it — 60 of them plus a name
    // would be two UTF-16 units each and must not read as double.
    assert.equal(checkName('Layla ' + '🌅'.repeat(MAX_NAME_LENGTH - 6)), null)
  })

  test('too long is reported before the letter rules', () => {
    assert.equal(checkName('1'.repeat(MAX_NAME_LENGTH + 1))?.code, 'tooLong')
  })
})

describe('normalizeName — what actually gets stored', () => {
  test('collapses whitespace runs and trims the ends', () => {
    assert.equal(normalizeName('  Layla   Hassan  '), 'Layla Hassan')
    assert.equal(normalizeName('Layla\n\tHassan'), 'Layla Hassan')
  })

  test('drops the invisible characters a paste brings with it', () => {
    assert.equal(normalizeName('​Layla­Hassan﻿'), 'LaylaHassan')
  })

  test('leaves case and non-Latin scripts alone', () => {
    assert.equal(normalizeName('  محمد أحمد '), 'محمد أحمد')
    assert.equal(normalizeName('LAYLA hassan'), 'LAYLA hassan')
  })
})

describe('messages', () => {
  test('every problem code has a sentence, and the numeric one names the cause', () => {
    for (const code of ['required', 'letters', 'tooShort', 'tooLong']) {
      const message = nameProblemMessage({ code })
      assert.equal(typeof message, 'string')
      assert.ok(message.length > 0, `${code} needs a message`)
    }
    assert.match(nameProblemMessage({ code: 'letters' }), /letters/)
    assert.match(nameProblemMessage({ code: 'tooLong' }), new RegExp(String(MAX_NAME_LENGTH)))
  })

  test('validateName is the one-shot form', () => {
    assert.equal(validateName('Layla Hassan'), null)
    assert.equal(validateName('12345'), nameProblemMessage({ code: 'letters' }))
  })
})

describe('fallbackNameFromEmail — the name for an account created without one', () => {
  test('uses the local part when it is a usable name', () => {
    assert.equal(fallbackNameFromEmail('layla@email.com'), 'layla')
    assert.equal(fallbackNameFromEmail('layla.hassan@email.com'), 'layla.hassan')
  })

  test('never seeds the very name this policy refuses', () => {
    // `0100@gmail.com` is a real shape in Egypt — a phone number as a mailbox.
    assert.equal(fallbackNameFromEmail('0100@gmail.com'), 'Guest')
    assert.equal(fallbackNameFromEmail('01012345678@gmail.com'), 'Guest')
    assert.equal(fallbackNameFromEmail('a@gmail.com'), 'Guest')
    assert.equal(fallbackNameFromEmail(''), 'Guest')
    assert.equal(fallbackNameFromEmail(null), 'Guest')
  })

  test('whatever it returns passes the policy', () => {
    for (const email of ['layla@email.com', '0100@gmail.com', '', 'a@b.co', '٠١٢@gmail.com']) {
      assert.equal(isValidName(fallbackNameFromEmail(email)), true, email)
    }
  })
})
