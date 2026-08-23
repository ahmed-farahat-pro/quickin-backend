// Unit tests for src/lib/local/name-policy.ts — the rule every path that sets a
// display name clears (signup, the profile save behind Edit profile, the host
// application, and the iOS `NameRules` / Android `NameRules` twins).
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

describe('checkName — a name is letters and nothing else', () => {
  test('a numeric-only name is refused', () => {
    // Every one of these created an account whose display name a host would read
    // next to a booking request.
    for (const digits of ['12345', '0', '007', '0100', '1234567890', '42 42']) {
      assert.equal(checkName(digits)?.code, 'invalidCharacters', `${digits} must be refused`)
    }
  })

  test('Arabic-Indic and other non-Latin digits are digits too', () => {
    // ٠١٢٣ is `0123` to the guest who typed it — a name-shaped hole otherwise.
    assert.equal(checkName('٠١٢٣٤')?.code, 'invalidCharacters')
    assert.equal(checkName('۰۱۲۳۴')?.code, 'invalidCharacters')
    assert.equal(checkName('０１２３４')?.code, 'invalidCharacters')
  })

  test('one digit is enough to refuse an otherwise ordinary name', () => {
    // The rule is not "mostly letters" — the field is matched against an ID
    // document, and `Layla2` is not what the document says.
    for (const name of ['Layla2', 'Layla Hassan 2', 'Ahmed01', 'محمد2']) {
      assert.equal(checkName(name)?.code, 'invalidCharacters', `${name} must be refused`)
    }
  })

  test('Franco-Arabic spellings are refused — this is the rule that changed', () => {
    // These were deliberately accepted by the first version of this policy,
    // which asked only that a name contain some letter. A guest who writes
    // `Ma7moud` is now asked for `Mahmoud`, the spelling on the ID.
    for (const name of ['Ma7moud', '3omar Hassan', 'Sha2wa', '7assan 3ly']) {
      assert.equal(checkName(name)?.code, 'invalidCharacters', `${name} must be refused`)
    }
  })

  test('symbols, punctuation and emoji are refused', () => {
    for (const junk of ['...', '???', '@@@', '🌅🌅', 'Layla 🌅', 'Layla_Hassan', 'J.', 'layla@mail.com', '<b>Layla</b>']) {
      assert.equal(checkName(junk)?.code, 'invalidCharacters', `${junk} must be refused`)
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

  test('the accent and the harakat travel as combining marks, and are letters here', () => {
    // A phone can send `José` as `e` + U+0301 rather than as `é`, and Arabic
    // typed with diacritics carries a mark after most letters. Neither is
    // `\p{L}`, and refusing `\p{M}` would refuse the scripts this rule exists
    // to serve.
    assert.equal(checkName('José Ángel'), null)
    assert.equal(checkName('مُحَمَّد'), null)
  })

  test('the apostrophe and hyphen a phone actually sends', () => {
    // Smart punctuation rewrites `'` to `’` as it is typed, and a name pasted
    // from a document carries the typographic hyphens. The guest never made the
    // substitution and cannot see it.
    assert.equal(checkName('O’Brien'), null)
    assert.equal(checkName('Jean‐Luc'), null)
    assert.equal(checkName('Jean‑Luc'), null)
  })
})

describe('checkName — the rest of the rules', () => {
  test('an empty or whitespace-only name is `required`, not a character problem', () => {
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

  test('a name of legal punctuation only is `letters` — it is still not a name', () => {
    // The one case `invalidCharacters` cannot catch: every character is allowed,
    // and there is no name in there anyway.
    for (const junk of ['-----', "'''", "- '"]) {
      assert.equal(checkName(junk)?.code, 'letters', `${junk} must be refused`)
    }
  })

  test('a single letter is `tooShort`', () => {
    assert.equal(checkName('A')?.code, 'tooShort')
    assert.equal(checkName("A'")?.code, 'tooShort')
    assert.equal(MIN_NAME_LETTERS, 2)
  })

  test('`invalidCharacters` is reported before `letters` and `tooShort`', () => {
    // Both rules fail for `5`; telling a guest to add a second character would
    // send them to `55`, which is refused for a reason they were never told.
    assert.equal(checkName('5')?.code, 'invalidCharacters')
    assert.equal(checkName('A1')?.code, 'invalidCharacters')
  })

  test('length is measured in characters, not UTF-16 units', () => {
    assert.equal(checkName('م'.repeat(MAX_NAME_LENGTH)), null)
    assert.equal(checkName('م'.repeat(MAX_NAME_LENGTH + 1))?.code, 'tooLong')
    // A letter outside the BMP is one character to whoever typed it, and 60 of
    // them are two UTF-16 units each — they must not read as 120.
    assert.equal(checkName('𐌰'.repeat(MAX_NAME_LENGTH)), null)
    assert.equal(checkName('𐌰'.repeat(MAX_NAME_LENGTH + 1))?.code, 'tooLong')
  })

  test('too long is reported before the character rules', () => {
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

  test('normalizes only — it does not strip what the policy refuses', () => {
    // The guest is told about `Ma7moud`, not silently renamed to `Mamoud`.
    assert.equal(normalizeName('Ma7moud'), 'Ma7moud')
  })
})

describe('messages', () => {
  test('every problem code has a sentence, and each names its cause', () => {
    for (const code of ['required', 'invalidCharacters', 'letters', 'tooShort', 'tooLong']) {
      const message = nameProblemMessage({ code })
      assert.equal(typeof message, 'string')
      assert.ok(message.length > 0, `${code} needs a message`)
    }
    assert.match(nameProblemMessage({ code: 'invalidCharacters' }), /letters only/)
    assert.match(nameProblemMessage({ code: 'letters' }), /letters/)
    assert.match(nameProblemMessage({ code: 'tooLong' }), new RegExp(String(MAX_NAME_LENGTH)))
  })

  test('validateName is the one-shot form', () => {
    assert.equal(validateName('Layla Hassan'), null)
    assert.equal(validateName('12345'), nameProblemMessage({ code: 'invalidCharacters' }))
  })
})

describe('fallbackNameFromEmail — the name for an account created without one', () => {
  test('uses the local part when it is a usable name', () => {
    assert.equal(fallbackNameFromEmail('layla@email.com'), 'layla')
  })

  test('reads the separators of an address as the spaces they stand for', () => {
    // `layla.hassan` is a name written the only way an address lets you write
    // it — and `layla.hassan` itself would fail the rule it has to clear.
    assert.equal(fallbackNameFromEmail('layla.hassan@email.com'), 'layla hassan')
    assert.equal(fallbackNameFromEmail('layla_hassan@email.com'), 'layla hassan')
    assert.equal(fallbackNameFromEmail('layla.hassan+booking@email.com'), 'layla hassan booking')
  })

  test('never seeds the very name this policy refuses', () => {
    // `0100@gmail.com` is a real shape in Egypt — a phone number as a mailbox.
    assert.equal(fallbackNameFromEmail('0100@gmail.com'), 'Guest')
    assert.equal(fallbackNameFromEmail('01012345678@gmail.com'), 'Guest')
    assert.equal(fallbackNameFromEmail('layla2000@gmail.com'), 'Guest')
    assert.equal(fallbackNameFromEmail('ma7moud@gmail.com'), 'Guest')
    assert.equal(fallbackNameFromEmail('a@gmail.com'), 'Guest')
    assert.equal(fallbackNameFromEmail(''), 'Guest')
    assert.equal(fallbackNameFromEmail(null), 'Guest')
  })

  test('whatever it returns passes the policy', () => {
    for (const email of ['layla@email.com', 'layla.hassan@e.co', '0100@gmail.com', '', 'a@b.co', '٠١٢@gmail.com']) {
      assert.equal(isValidName(fallbackNameFromEmail(email)), true, email)
    }
  })
})
