// Unit tests for src/lib/local/phone-core.ts — the phone-number rule behind
// POST /api/local/host/apply, the host application the iOS and Android apps send.
// The module is byte-identical to the web's copy (check-phone-core-parity.mjs),
// so this file is too: the assertions are the contract both repos must keep.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. phone-core.ts has no relative imports, which is what makes
// it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PHONE_CHARS,
  MIN_PHONE_DIGITS,
  MAX_PHONE_DIGITS,
  filterPhoneInput,
  isValidPhone,
  normalizePhone,
  toAsciiDigits,
} from '../../src/lib/local/phone-core.ts'

describe('normalizePhone — letters are not a phone number', () => {
  // The reported bug: the field took a word and an application reached review
  // with nothing anyone could dial.
  test('a word is refused', () => {
    for (const v of ['asdf', 'hello', 'not a phone', 'call me']) {
      assert.equal(normalizePhone(v), null, `${v} should not be a phone number`)
    }
  })

  test('letters mixed into a real number are refused, never silently dropped', () => {
    // Stripping them would turn `010abc12345678` into a number the host never
    // typed — a wrong number on file is worse than a rejected form.
    assert.equal(normalizePhone('010abc12345678'), null)
    assert.equal(normalizePhone('0101234567x'), null)
    assert.equal(normalizePhone('+20 10 1234 5678 ext 4'), null)
  })

  test('an empty or separator-only field is refused', () => {
    for (const v of ['', '   ', '+', '++', '()', '- - -', null, undefined]) {
      assert.equal(normalizePhone(v), null)
    }
  })
})

describe('normalizePhone — Egyptian mobiles land in one form', () => {
  // The same host typed three ways is one applicant in /ops, not three.
  test('every way of writing the same mobile normalizes identically', () => {
    for (const v of [
      '01012345678',
      '010 1234 5678',
      '010-1234-5678',
      '(010) 1234 5678',
      '+201012345678',
      '+20 10 1234 5678',
      '00201012345678',
      '0020 101 234 5678',
      '201012345678',
    ]) {
      assert.equal(normalizePhone(v), '01012345678', `${v} should normalize`)
    }
  })

  test('all four Egyptian mobile prefixes are accepted', () => {
    assert.equal(normalizePhone('+20 100 123 4567'), '01001234567') // Vodafone
    assert.equal(normalizePhone('+20 111 123 4567'), '01111234567') // Etisalat
    assert.equal(normalizePhone('+20 122 123 4567'), '01221234567') // Orange
    assert.equal(normalizePhone('+20 155 123 4567'), '01551234567') // WE
  })

  test('a mobile one digit short or one digit long is refused', () => {
    assert.equal(normalizePhone('0101234567'), null) // 10 digits
    assert.equal(normalizePhone('010123456789'), null) // 12 digits
  })
})

describe('normalizePhone — numbers that are not Egyptian mobiles', () => {
  test('an Egyptian landline keeps its local trunk-prefixed form', () => {
    // `+0223456789` is not a number anyone can dial, so a leading 0 stays a 0.
    assert.equal(normalizePhone('02 2345 6789'), '0223456789')
    assert.equal(normalizePhone('(02) 2345-6789'), '0223456789')
  })

  test('a foreign number is kept in E.164 — a host abroad is still payable', () => {
    assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958')
    assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671')
    assert.equal(normalizePhone('00966501234567'), '+966501234567')
  })

  test('the E.164 digit bounds are enforced at both ends', () => {
    const short = '1'.repeat(MIN_PHONE_DIGITS - 1)
    const long = '9'.repeat(MAX_PHONE_DIGITS + 1)
    assert.equal(normalizePhone(short), null)
    assert.equal(normalizePhone(long), null)
    assert.equal(normalizePhone('9'.repeat(MAX_PHONE_DIGITS)), `+${'9'.repeat(MAX_PHONE_DIGITS)}`)
  })

  test('a field longer than the input cap is refused before anything else', () => {
    assert.equal(normalizePhone('0'.repeat(MAX_PHONE_CHARS + 1)), null)
  })
})

describe('normalizePhone — Arabic-Indic digits are digits', () => {
  // The site runs in Arabic. Refusing ٠١٠… would reject a host who typed their
  // own number correctly on their own keyboard.
  test('an Arabic-Indic mobile normalizes like its ASCII twin', () => {
    assert.equal(normalizePhone('٠١٠١٢٣٤٥٦٧٨'), '01012345678')
    assert.equal(normalizePhone('+٢٠ ١٠ ١٢٣٤ ٥٦٧٨'), '01012345678')
  })

  test('Persian digits fold too', () => {
    assert.equal(normalizePhone('۰۱۰۱۲۳۴۵۶۷۸'), '01012345678')
  })

  test('toAsciiDigits leaves everything else alone', () => {
    assert.equal(toAsciiDigits('+20 (10) ٤-٥'), '+20 (10) 4-5')
    assert.equal(toAsciiDigits('abc'), 'abc')
  })
})

describe('isValidPhone', () => {
  test('agrees with normalizePhone', () => {
    assert.equal(isValidPhone('+20 10 1234 5678'), true)
    assert.equal(isValidPhone('asdf'), false)
    assert.equal(isValidPhone(''), false)
    assert.equal(isValidPhone(12345678), true) // a number is stringified, not thrown at
  })
})

describe('filterPhoneInput — what the field holds while typing', () => {
  test('letters never make it into the field', () => {
    assert.equal(filterPhoneInput('abc'), '')
    assert.equal(filterPhoneInput('010abc1234'), '0101234')
    assert.equal(filterPhoneInput('٠١٠abc'), '010')
  })

  test('the separators people type survive, so the field stays readable', () => {
    assert.equal(filterPhoneInput('+20 (10) 1234-5678'), '+20 (10) 1234-5678')
    assert.equal(filterPhoneInput('010 1234 5678'), '010 1234 5678')
  })

  test('a + is kept only at the front', () => {
    assert.equal(filterPhoneInput('+201012345678'), '+201012345678')
    assert.equal(filterPhoneInput('010+1234'), '0101234')
  })

  test('typing is capped at the field length', () => {
    assert.equal(filterPhoneInput('1'.repeat(MAX_PHONE_CHARS + 10)).length, MAX_PHONE_CHARS)
  })

  test('what it leaves behind is not automatically valid', () => {
    // It filters; normalizePhone still decides. `+++` and `(-)` pass the filter.
    assert.equal(filterPhoneInput('(-)'), '(-)')
    assert.equal(normalizePhone(filterPhoneInput('(-)')), null)
  })

  test('a filtered value round-trips: whatever survives typing, normalizes', () => {
    const typed = 'hello +20 10 1234 5678 please'
    assert.equal(normalizePhone(filterPhoneInput(typed)), '01012345678')
  })
})
