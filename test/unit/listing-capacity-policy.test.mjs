// Unit tests for src/lib/local/listing-capacity-policy.ts — the floor AND the
// ceiling every path that sets a listing's capacity clears (`createListing`, the
// four capacity branches of the edit patch, and the create + edit wizards in
// both mobile apps, whose steppers used to go down to 0 and whose bedroom count
// had no upper bound at all).
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
  DEFAULT_MAX_BEDROOMS,
  MAX_BEDROOMS_BY_PROPERTY_TYPE,
  MAX_CAPACITY,
  MIN_CAPACITY,
  maxListingCapacity,
  normalizePropertyTypeKey,
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
        {
          code: 'tooFew',
          field,
          min: MIN_CAPACITY,
          max: maxListingCapacity(field),
          propertyType: null,
        },
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

  test('a whole number between the floor and the ceiling is accepted', () => {
    for (const field of CAPACITY_FIELDS) {
      assert.equal(checkListingCapacity(field, 1), null, field)
      assert.equal(checkListingCapacity(field, '1'), null, field)
      assert.equal(checkListingCapacity(field, 3), null, field)
    }
  })

  test('every field is bounded from above — nothing is left open-ended', () => {
    // The defect: nothing refused a number from the top, so a Studio published
    // with 27,373 bedrooms (a real row on Neon). The same keypad types into all
    // four fields, so all four are bounded.
    for (const field of CAPACITY_FIELDS) {
      assert.equal(checkListingCapacity(field, 27373)?.code, 'tooMany', field)
    }
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

describe('the bedroom ceiling — product’s per-property-type table', () => {
  // The table as product wrote it, transcribed here so a change to the module
  // has to be a deliberate change to THIS list too. Studio is the one row that
  // is not a straight copy: product wrote "must be 0", meaning a studio has no
  // separate bedroom, and MIN_CAPACITY is 1 — so the rule is "exactly 1".
  const TABLE = [
    ['Apartment', 5],
    ['House', 6],
    ['Villa', 8],
    ['Cabin', 3],
    ['Studio', 1],
    ['Loft', 3],
    ['Chalet', 6],
    ['Cottage', 4],
    ['Guest suite', 2],
  ]

  test('every type accepts its maximum and refuses one more', () => {
    for (const [type, max] of TABLE) {
      assert.equal(checkListingCapacity('bedrooms', max, type), null, `${type} @ ${max}`)
      assert.equal(
        checkListingCapacity('bedrooms', max + 1, type)?.code,
        'tooMany',
        `${type} @ ${max + 1}`
      )
    }
  })

  test('the reported defect: Cabin and Chalet refuse an unrealistic count', () => {
    // Steps to reproduce, as filed: pick Cabin or Chalet, type a big number,
    // submit. Both used to be accepted.
    assert.equal(checkListingCapacity('bedrooms', 40, 'Cabin')?.code, 'tooMany')
    assert.equal(checkListingCapacity('bedrooms', 40, 'Chalet')?.code, 'tooMany')
    assert.equal(checkListingCapacity('bedrooms', 99999, 'Cabin')?.code, 'tooMany')
  })

  test('the floor still applies underneath the ceiling', () => {
    for (const [type] of TABLE) {
      assert.equal(checkListingCapacity('bedrooms', 0, type)?.code, 'tooFew', type)
      assert.equal(checkListingCapacity('bedrooms', 1, type), null, type)
    }
  })

  test('a Studio is exactly one room — 1 passes, 2 does not', () => {
    // Product's "must be 0" and the platform floor of 1 are the same statement:
    // the single room IS the bedroom. What must not happen is a studio claiming
    // a second one.
    assert.equal(checkListingCapacity('bedrooms', 1, 'Studio'), null)
    assert.equal(checkListingCapacity('bedrooms', 2, 'Studio')?.code, 'tooMany')
  })

  test('the type is matched however the client cased or spaced it', () => {
    // property_type is stored in English and typed by four different clients;
    // 'guest suite', 'Guest Suite' and 'Guest  suite' are one type.
    for (const spelling of ['cabin', 'CABIN', ' Cabin ', 'CaBiN']) {
      assert.equal(maxListingCapacity('bedrooms', spelling), 3, spelling)
    }
    for (const spelling of ['Guest suite', 'guest suite', 'GUEST SUITE', 'Guest  suite']) {
      assert.equal(maxListingCapacity('bedrooms', spelling), 2, spelling)
    }
  })

  test('a type nobody has ruled on gets the most permissive number, not the strictest', () => {
    // 'Guest House' is a real stored value (the API accepts it, the Android
    // picker offers it) and is absent from product's table. Judging it harder
    // than a type they DID rule on would refuse listings over a rule that does
    // not exist.
    assert.equal(maxListingCapacity('bedrooms', 'Guest House'), DEFAULT_MAX_BEDROOMS)
    assert.equal(maxListingCapacity('bedrooms', 'Houseboat'), DEFAULT_MAX_BEDROOMS)
    assert.equal(checkListingCapacity('bedrooms', DEFAULT_MAX_BEDROOMS, 'Guest House'), null)
    assert.equal(
      DEFAULT_MAX_BEDROOMS,
      Math.max(...Object.values(MAX_BEDROOMS_BY_PROPERTY_TYPE)),
      'the fallback must stay the most permissive number in the table'
    )
  })

  test('an absent or empty property type falls back rather than throwing', () => {
    // The API reaches here with whatever the client sent, and a PATCH that
    // changes only the number carries no type at all until db.ts reads it back.
    for (const missing of [undefined, null, '', '   ']) {
      assert.equal(maxListingCapacity('bedrooms', missing), DEFAULT_MAX_BEDROOMS)
    }
    assert.equal(normalizePropertyTypeKey('  '), null)
    assert.equal(normalizePropertyTypeKey('Guest  Suite'), 'guest suite')
  })

  test('the other three fields ignore the property type entirely', () => {
    // Only bedrooms has a per-type table; a Cabin does not get fewer bathrooms.
    for (const field of ['beds', 'bathrooms', 'guests']) {
      assert.equal(maxListingCapacity(field, 'Cabin'), MAX_CAPACITY[field], field)
      assert.equal(maxListingCapacity(field, 'Villa'), MAX_CAPACITY[field], field)
      assert.equal(checkListingCapacity(field, MAX_CAPACITY[field], 'Cabin'), null, field)
      assert.equal(checkListingCapacity(field, MAX_CAPACITY[field] + 1, 'Cabin')?.code, 'tooMany', field)
    }
  })
})

describe('what a refused count says', () => {
  test('the sentence names the property type and the number it may not pass', () => {
    // A host who typed 40 into a Cabin needs to read the actual limit, not
    // "invalid" — the number is the whole content of the message.
    assert.equal(
      validateListingCapacity('bedrooms', 40, 'Cabin'),
      'A Cabin can have at most 3 bedrooms'
    )
    assert.equal(
      validateListingCapacity('bedrooms', 12, 'Chalet'),
      'A Chalet can have at most 6 bedrooms'
    )
  })

  test('a studio is told what it is, not handed a cap it cannot work under', () => {
    // "at most 1 bedroom" is true but reads like room to manoeuvre.
    assert.equal(
      validateListingCapacity('bedrooms', 3, 'Studio'),
      'A Studio is a single room — it has exactly 1 bedroom'
    )
  })

  test('a type outside the table is refused impersonally', () => {
    // Naming 'Guest House' would state a per-type rule product never wrote.
    const msg = validateListingCapacity('bedrooms', 40, 'Guest House')
    assert.equal(msg, 'A listing can have at most 8 bedrooms')
    assert.doesNotMatch(msg, /Guest House/)
  })

  test('the three blanket ceilings read as the listing’s, not the type’s', () => {
    assert.equal(validateListingCapacity('beds', 500, 'Cabin'), 'A listing can have at most 30 beds')
    assert.equal(validateListingCapacity('bathrooms', 500), 'A listing can have at most 20 bathrooms')
    assert.equal(validateListingCapacity('guests', 500), 'A listing can sleep at most 32 guests')
  })

  test('every code produces a non-empty sentence', () => {
    // Same contract the floor codes already hold: the API returns this as
    // `error`, and the mobile apps render it verbatim.
    for (const field of CAPACITY_FIELDS) {
      const problem = checkListingCapacity(field, 99999, 'Cabin')
      assert.equal(problem?.code, 'tooMany', field)
      assert.ok(listingCapacityProblemMessage(problem).length > 0, field)
    }
  })

  test('the problem carries the bound a client needs to localize it', () => {
    // Clients that translate read code + field + max rather than the sentence.
    assert.deepEqual(checkListingCapacity('bedrooms', 9, 'Cabin'), {
      code: 'tooMany',
      field: 'bedrooms',
      min: MIN_CAPACITY,
      max: 3,
      propertyType: 'Cabin',
    })
  })

  test('isValidListingCapacity is the same decision as the gate on Publish', () => {
    assert.equal(isValidListingCapacity('bedrooms', 3, 'Cabin'), true)
    assert.equal(isValidListingCapacity('bedrooms', 4, 'Cabin'), false)
    assert.equal(isValidListingCapacity('bedrooms', 4, 'Villa'), true)
  })
})
