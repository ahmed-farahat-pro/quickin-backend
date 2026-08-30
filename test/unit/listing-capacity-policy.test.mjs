// Unit tests for src/lib/local/listing-capacity-policy.ts — the floor every path
// that sets a listing's capacity clears (`createListing`, the four capacity
// branches of the edit patch, and the create + edit wizards in both mobile apps,
// whose steppers used to go down to 0).
//
// Byte-identical to the web repo's copy of the module under test — see
// scripts/check-listing-capacity-policy-parity.mjs.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. listing-capacity-policy.ts has no imports, which is what
// makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPACITY_FIELDS,
  MIN_CAPACITY,
  checkListingCapacity,
  isBlankCapacity,
  isValidListingCapacity,
  listingCapacityProblemMessage,
  parseCapacity,
  toAsciiDigits,
  validateListingCapacity,
} from '../../src/lib/local/listing-capacity-policy.ts'

describe('checkListingCapacity — the bug this policy exists for', () => {
  test('zero is refused for every field', () => {
    // The reported defect: bedrooms 0, beds 0, bathrooms 0 went through the
    // create form and published as a listing with nowhere to sleep.
    for (const field of CAPACITY_FIELDS) {
      assert.deepEqual(
        checkListingCapacity(field, 0),
        { code: 'tooFew', field, min: MIN_CAPACITY },
        field
      )
    }
  })

  test("the string '0' is refused too — that is what a form field actually sends", () => {
    // The form state is a string; a check that only looked at numbers would pass
    // the exact value the browser posts.
    for (const field of CAPACITY_FIELDS) {
      assert.equal(checkListingCapacity(field, '0')?.code, 'tooFew', field)
    }
  })

  test('a negative count is refused', () => {
    // `type="number"` accepts a typed minus sign, and the mobile clients send
    // whatever JSON they hold.
    for (const v of [-1, '-1', -12]) {
      assert.equal(checkListingCapacity('beds', v)?.code, 'notWhole', String(v))
    }
  })

  test('an empty field hears `required`, not `notWhole`', () => {
    // Order matters, as everywhere else in this codebase: "you skipped this" and
    // "that is not a number" are different things to fix. `Number('')` is 0, so
    // a blank field used to arrive as a zero nobody typed.
    for (const v of ['', '   ', null, undefined]) {
      assert.equal(checkListingCapacity('bedrooms', v)?.code, 'required', JSON.stringify(v))
    }
  })

  test('invisible pasted characters do not make a field filled in', () => {
    assert.equal(checkListingCapacity('beds', '​﻿')?.code, 'required')
  })
})

describe('checkListingCapacity — what a count has to be', () => {
  test('a fraction is refused rather than floored', () => {
    // `Math.floor(Number(v))` stood here and turned 2.5 bedrooms into 2 and 0.5
    // bathrooms into the zero this module refuses.
    for (const v of [2.5, '2.5', '1.9', 0.5, '0.5']) {
      assert.equal(checkListingCapacity('bathrooms', v)?.code, 'notWhole', String(v))
    }
  })

  test('the JSON shapes Number() would happily coerce are refused', () => {
    // `Number(true)` is 1 and `Number(['2'])` is 2 — both would have passed a
    // bare numeric check, and neither is a count anybody typed.
    for (const v of [true, false, [], ['2'], {}, 'two', '1e3', '0x2', NaN, Infinity]) {
      assert.equal(isValidListingCapacity('beds', v), false, JSON.stringify(v) ?? String(v))
    }
  })

  test('a whole number at or above the floor is accepted', () => {
    for (const field of CAPACITY_FIELDS) {
      assert.equal(checkListingCapacity(field, 1), null, field)
      assert.equal(checkListingCapacity(field, '1'), null, field)
      assert.equal(checkListingCapacity(field, 12), null, field)
    }
  })

  test('a large but real property is not an error', () => {
    // Deliberately no upper bound: a 40-bedroom villa exists, and a cap invented
    // in this module would start refusing edits to rows that already exist.
    assert.equal(checkListingCapacity('bedrooms', 40), null)
    assert.equal(checkListingCapacity('guests', 120), null)
  })

  test('surrounding whitespace is not a typo worth refusing', () => {
    assert.equal(checkListingCapacity('beds', ' 3 '), null)
    assert.equal(parseCapacity(' 3 '), 3)
  })
})

describe('Arabic-Indic digits', () => {
  test('a count typed on an Arabic keyboard is the number it plainly is', () => {
    // The site runs in Arabic and these values also arrive as JSON from the
    // mobile apps, where the browser number input is no help. `Number('٣')` is
    // NaN, so without folding, a host typing their own bedroom count correctly
    // would be told it is not a whole number.
    assert.equal(parseCapacity('٣'), 3)
    assert.equal(parseCapacity('۴'), 4)
    assert.equal(checkListingCapacity('bedrooms', '٢'), null)
  })

  test('folding does not smuggle a zero past the floor', () => {
    assert.equal(checkListingCapacity('bedrooms', '٠')?.code, 'tooFew')
  })

  test('toAsciiDigits leaves everything else alone', () => {
    assert.equal(toAsciiDigits('12'), '12')
    assert.equal(toAsciiDigits('abc'), 'abc')
  })
})

describe('parseCapacity', () => {
  test('returns null for anything checkListingCapacity would refuse', () => {
    // The two must never disagree about a value that would be stored — parse is
    // only ever called after check has said yes.
    for (const v of ['', null, undefined, '2.5', 'two', true, [], -1]) {
      assert.equal(parseCapacity(v), null, JSON.stringify(v) ?? String(v))
    }
  })

  test('zero parses (it is a number) — the floor is check’s job, not parse’s', () => {
    assert.equal(parseCapacity(0), 0)
    assert.equal(checkListingCapacity('beds', 0)?.code, 'tooFew')
  })
})

describe('isBlankCapacity', () => {
  test('blank is told apart from wrong', () => {
    assert.equal(isBlankCapacity(''), true)
    assert.equal(isBlankCapacity(null), true)
    assert.equal(isBlankCapacity(undefined), true)
    assert.equal(isBlankCapacity(0), false)
    assert.equal(isBlankCapacity('abc'), false)
  })
})

describe('messages', () => {
  test('every problem the checker can return has a sentence', () => {
    for (const field of CAPACITY_FIELDS) {
      for (const v of ['', 'abc', 0]) {
        const problem = checkListingCapacity(field, v)
        assert.ok(problem, `${field}/${v}`)
        const msg = listingCapacityProblemMessage(problem)
        assert.equal(typeof msg, 'string')
        assert.ok(msg.length > 0, `${field}/${v}`)
      }
    }
  })

  test('the sentence names the field, so a 400 says which one to fix', () => {
    assert.match(validateListingCapacity('bedrooms', 0), /bedroom/)
    assert.match(validateListingCapacity('bathrooms', 0), /bathroom/)
    assert.match(validateListingCapacity('guests', 0), /guest/)
  })

  test('guests reads as sleeping, not as having', () => {
    // "A listing needs at least 1 guest" would be a different rule entirely.
    assert.match(validateListingCapacity('guests', 0), /sleep/)
  })

  test('validateListingCapacity is null when the count is fine', () => {
    assert.equal(validateListingCapacity('beds', 2), null)
  })
})
