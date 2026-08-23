// Unit tests for src/lib/local/profile-core.ts — the age and "about you" rules
// behind /account's profile form and the API that stores them.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. profile-core.ts has no relative imports, which is what
// makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_AGE,
  MAX_AGE,
  MAX_BIO_LENGTH,
  ageProblemMessage,
  bioLength,
  bioProblemMessage,
  checkAge,
  checkBio,
  filterBioInput,
  isBlankField,
  isValidAge,
  isValidBio,
  normalizeBio,
  parseAge,
  toAsciiDigits,
  validateAge,
  validateBio,
} from '../../src/lib/local/profile-core.ts'

describe('age — optional means blank is not an error', () => {
  // The reported gap was that the web could not edit these at all. The first
  // thing that must hold once it can is that not filling one in is allowed:
  // every one of these fields is optional on iOS, and a form that demanded an
  // age to save a name would be a new bug wearing the fix's clothes.
  test('an empty field is accepted and stores nothing', () => {
    for (const v of ['', '   ', null, undefined, '​']) {
      assert.equal(checkAge(v), null, `${JSON.stringify(v)} should be accepted`)
      assert.equal(parseAge(v), null, `${JSON.stringify(v)} should store null`)
    }
  })

  test('blank is told apart from wrong', () => {
    assert.equal(isBlankField(''), true)
    assert.equal(isBlankField('   '), true)
    assert.equal(isBlankField('0'), false)
    assert.equal(isBlankField('abc'), false)
  })
})

describe('age — a number, and a number a person could be', () => {
  test('an ordinary age is accepted and comes back as a number', () => {
    for (const [input, expected] of [
      ['34', 34],
      [' 34 ', 34],
      [34, 34],
      ['18', 18],
      [String(MIN_AGE), MIN_AGE],
      [String(MAX_AGE), MAX_AGE],
    ]) {
      assert.equal(checkAge(input), null, `${input} should be accepted`)
      assert.equal(parseAge(input), expected)
    }
  })

  test('a word is not an age', () => {
    for (const v of ['abc', 'thirty', '3o', 'twenty-one']) {
      assert.deepEqual(checkAge(v), { code: 'notANumber' })
    }
  })

  test('the notations Number() would have accepted are refused', () => {
    // `Number('3e2')` is 300 and `Number('0x22')` is 34 — the first would pass a
    // range check as an age nobody is, the second would silently store a number
    // the user did not type. Neither is what a person means by their age.
    for (const v of ['3e2', '0x22', '34.5', '3,4', '+34', '-34', '1_8']) {
      assert.deepEqual(checkAge(v), { code: 'notANumber' }, `${v} should be refused`)
      assert.equal(parseAge(v), null)
    }
  })

  test('a slipped number pad is caught at both ends', () => {
    assert.deepEqual(checkAge('0'), { code: 'tooYoung' })
    assert.deepEqual(checkAge('4'), { code: 'tooYoung' })
    assert.deepEqual(checkAge(String(MIN_AGE - 1)), { code: 'tooYoung' })
    assert.deepEqual(checkAge(String(MAX_AGE + 1)), { code: 'tooOld' })
    assert.deepEqual(checkAge('999'), { code: 'tooOld' })
  })

  test('an age typed on an Arabic keyboard is an age', () => {
    // The site runs in Arabic. `٣٤` is thirty-four, and refusing it would turn
    // away a guest typing their own age correctly.
    assert.equal(toAsciiDigits('٣٤'), '34')
    assert.equal(checkAge('٣٤'), null)
    assert.equal(parseAge('٣٤'), 34)
    assert.equal(parseAge('۳۴'), 34)   // Persian digits
  })

  test('isValidAge and validateAge agree with checkAge', () => {
    assert.equal(isValidAge('34'), true)
    assert.equal(isValidAge(''), true)
    assert.equal(isValidAge('abc'), false)
    assert.equal(validateAge('34'), null)
    assert.equal(validateAge('999'), ageProblemMessage({ code: 'tooOld' }))
    assert.match(validateAge('abc'), /number/i)
  })

  test('each problem has its own sentence, and it names the bound', () => {
    assert.match(ageProblemMessage({ code: 'tooYoung' }), new RegExp(String(MIN_AGE)))
    assert.match(ageProblemMessage({ code: 'tooOld' }), new RegExp(String(MAX_AGE)))
    assert.notEqual(
      ageProblemMessage({ code: 'notANumber' }),
      ageProblemMessage({ code: 'tooYoung' })
    )
  })
})

describe('bio — a paragraph, stored as it reads', () => {
  test('an empty bio is fine', () => {
    for (const v of ['', '   ', '\n\n', null, undefined]) {
      assert.equal(checkBio(v), null)
      assert.equal(normalizeBio(v), '')
    }
  })

  test('line breaks survive — a bio is not a name', () => {
    // name-policy collapses every run of whitespace to one space. Doing that
    // here would run a two-paragraph introduction into one block.
    assert.equal(normalizeBio('Hi there.\nI host in Gouna.'), 'Hi there.\nI host in Gouna.')
    assert.equal(normalizeBio('One.\n\nTwo.'), 'One.\n\nTwo.')
  })

  test('the padding a paste brings with it is dropped', () => {
    assert.equal(normalizeBio('  Diver.  \n\n\n\n  Cook.  \n\n\n'), 'Diver.\n\nCook.')
    assert.equal(normalizeBio('Sea   and    sun'), 'Sea and sun')
    assert.equal(normalizeBio('​​​'), '')
  })

  test('CRLF from a pasted document is not two line breaks', () => {
    assert.equal(normalizeBio('One.\r\nTwo.'), 'One.\nTwo.')
    assert.equal(filterBioInput('One.\r\nTwo.'), 'One.\nTwo.')
  })

  test('invisibles cannot fill a bio, or its budget', () => {
    assert.equal(bioLength('​'.repeat(MAX_BIO_LENGTH + 50)), 0)
    assert.equal(checkBio('​'.repeat(MAX_BIO_LENGTH + 50)), null)
  })

  test('length counts characters, not UTF-16 units', () => {
    // An emoji is one character to whoever typed it, and MAX_BIO_LENGTH Arabic
    // characters must not read as twice that.
    assert.equal(bioLength('🏖️'), 2)          // emoji + variation selector
    assert.equal(bioLength('مرحبا'), 5)
    assert.equal(checkBio('🌊'.repeat(MAX_BIO_LENGTH)), null)
    assert.deepEqual(checkBio('🌊'.repeat(MAX_BIO_LENGTH + 1)), { code: 'tooLong' })
  })

  test('the cap is on what gets stored, not on what was typed', () => {
    // Trailing whitespace should not be what pushes a bio over the line.
    const atCap = 'a'.repeat(MAX_BIO_LENGTH)
    assert.equal(checkBio(atCap), null)
    assert.equal(checkBio(`${atCap}   \n\n`), null)
    assert.deepEqual(checkBio(`${atCap}b`), { code: 'tooLong' })
  })

  test('isValidBio and validateBio agree with checkBio', () => {
    assert.equal(isValidBio('Diver, cook, bad at chess.'), true)
    assert.equal(isValidBio('a'.repeat(MAX_BIO_LENGTH + 1)), false)
    assert.equal(validateBio('Hello'), null)
    assert.equal(validateBio('a'.repeat(MAX_BIO_LENGTH + 1)), bioProblemMessage({ code: 'tooLong' }))
    assert.match(bioProblemMessage({ code: 'tooLong' }), new RegExp(String(MAX_BIO_LENGTH)))
  })
})

describe('age — the field is not a way to publish a phone number', () => {
  // Why this module is now called from PATCH /api/local/profile and not only
  // from the web form. `contentguard` keeps a number out of the name and the
  // bio either side of the age on Edit profile, and out of every chat message,
  // but it never saw this field: `users.age` is an integer, so by the time the
  // digits are stored they are not text for a guard to read. The route reached
  // the column through `Number()`, which reads a phone number as an age.
  test('an Egyptian mobile number is not an age', () => {
    for (const number of [
      '01012345678',
      '01112345678',
      '00201012345678',
      '1012345678',
      '٠١٠١٢٣٤٥٦٧٨',
    ]) {
      assert.notEqual(checkAge(number), null, `${number} must not be storable as an age`)
      assert.equal(parseAge(number), null)
    }
  })

  test('the digits Number() used to wave through are gone, not truncated', () => {
    // Not "the first three digits of the number" — that would store 101 as an
    // age nobody typed. A refusal is the only honest answer to a phone number.
    assert.equal(parseAge('01012345678'), null)
    assert.deepEqual(checkAge('01012345678'), { code: 'notANumber' })
  })

  test('a four-digit run is refused whatever it spells', () => {
    // A year of birth, a room number, half a number split across two saves.
    for (const v of ['1996', '2026', '0100', '4567']) {
      assert.notEqual(checkAge(v), null, `${v} must not be storable as an age`)
    }
  })

  test('separators do not smuggle a number past the check', () => {
    for (const v of ['010 123 4567', '010-123-4567', '(010)1234567', '0_1_0']) {
      assert.deepEqual(checkAge(v), { code: 'notANumber' }, `${v} should be refused`)
    }
  })
})
