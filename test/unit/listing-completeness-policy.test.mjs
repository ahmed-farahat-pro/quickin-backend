// Unit tests for src/lib/local/listing-completeness-policy.ts — the bar a NEW
// listing clears before it exists (`createListing`, the /host/new form, and the
// create wizards in both mobile apps).
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. listing-completeness-policy.ts has no imports, which is
// what makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LISTING_REQUIRED_FIELDS,
  MIN_DESCRIPTION_LETTERS,
  MIN_LOCATION_LETTERS,
  MIN_LISTING_PHOTOS,
  checkListingAddress,
  checkListingCompleteness,
  checkListingEdit,
  checkListingDescription,
  checkListingPhotos,
  checkListingPinPresence,
  checkListingPropertyType,
  checkListingArea,
  isListingComplete,
  listingCompletenessProblemMessage,
  normalizeListingText,
  validateListingCompleteness,
  validateListingEdit,
} from '../../src/lib/local/listing-completeness-policy.ts'

/** A listing that answers everything — the baseline each test breaks one way. */
const COMPLETE = {
  description: 'A bright two-bedroom chalet a short walk from the beach, with a shaded terrace.',
  location: 'Sidi Abdel Rahman, Marsa Matrouh',
  region: 'north-coast',
  lat: 30.9,
  lng: 28.7,
  property_type: 'Chalet',
  images: ['https://cdn.example.com/a.jpg'],
}

describe('checkListingCompleteness — the bug this policy exists for', () => {
  test('title + price alone is not a listing', () => {
    // The reported defect, exactly as filed: a host typed a title and a price,
    // left everything else blank, and the listing was created.
    const problem = checkListingCompleteness({})
    assert.ok(problem, 'an empty listing must be refused')
    assert.equal(problem.field, 'description')
    assert.equal(problem.code, 'required')
  })

  test('the complete listing passes', () => {
    // The half that matters as much: the rule must not refuse a real listing.
    assert.equal(checkListingCompleteness(COMPLETE), null)
    assert.equal(isListingComplete(COMPLETE), true)
    assert.equal(validateListingCompleteness(COMPLETE), null)
  })

  test('every required field is caught when it alone is missing', () => {
    // Each field earns its place in LISTING_REQUIRED_FIELDS: drop exactly one
    // from an otherwise complete listing and that field is what gets reported.
    const drop = {
      description: { description: '' },
      location: { location: '' },
      region: { region: '', resort_id: '', resort_name: '' },
      pin: { lat: null, lng: null },
      propertyType: { property_type: '' },
      photos: { images: [] },
    }
    for (const field of LISTING_REQUIRED_FIELDS) {
      const problem = checkListingCompleteness({ ...COMPLETE, ...drop[field] })
      assert.equal(problem?.field, field, `${field} was not reported`)
    }
  })

  test('the first problem is reported in form order, not code order', () => {
    // A host who filled in nothing is sent to the top of the form, not to
    // whichever field the implementation happened to look at first.
    const problem = checkListingCompleteness({ property_type: '', description: '', location: '' })
    assert.equal(problem?.field, 'description')
  })
})

describe('checkListingDescription', () => {
  test('a missing description is required, not tooShort', () => {
    assert.deepEqual(checkListingDescription(''), { code: 'required', field: 'description' })
    assert.deepEqual(checkListingDescription(undefined), { code: 'required', field: 'description' })
    assert.deepEqual(checkListingDescription(null), { code: 'required', field: 'description' })
  })

  test('symbols-only is refused with `letters`, however long', () => {
    // Twenty of them clears any character-counting check — this is why the
    // module counts letters. `letters` before `tooShort` so the host hears the
    // real problem rather than being told to add a twenty-first symbol.
    assert.equal(checkListingDescription('@'.repeat(40))?.code, 'letters')
    assert.equal(checkListingDescription('...................'.repeat(3))?.code, 'letters')
    assert.equal(checkListingDescription('1234567890 1234567890 1234567890')?.code, 'letters')
  })

  test('a short description is tooShort and names the floor', () => {
    assert.deepEqual(checkListingDescription('Nice flat'), {
      code: 'tooShort',
      field: 'description',
      min: MIN_DESCRIPTION_LETTERS,
    })
  })

  test('letters are counted, not characters — punctuation and digits do not pad', () => {
    // Exactly MIN letters, buried in noise that a `.length >= 20` check would
    // have counted. The letters are what carry meaning, so they are what count.
    const justEnough = 'ab cd ef gh ij kl mn op qr st' // 20 letters
    assert.equal(checkListingDescription(justEnough), null)
    const padded = '2BR!!! 1,2,3 (4) - 5 6 7 8 9 10 11 12' // < 20 letters
    assert.equal(checkListingDescription(padded)?.code, 'tooShort')
  })

  test('Arabic counts — the rule is letters, not Latin letters', () => {
    // A description a real Egyptian host would write must not be refused for
    // being written in Arabic. Same reasoning as listing-title-policy.ts.
    assert.equal(checkListingDescription('شاليه واسع بغرفتين وإطلالة مباشرة على البحر'), null)
  })

  test('invisible characters do not make a description non-empty', () => {
    assert.equal(checkListingDescription('​​​﻿')?.code, 'required')
  })
})

describe('checkListingAddress', () => {
  test('a missing address is refused', () => {
    assert.deepEqual(checkListingAddress('   '), { code: 'required', field: 'location' })
  })

  test('a door number alone is not an address', () => {
    assert.deepEqual(checkListingAddress('12'), { code: 'letters', field: 'location' })
    assert.equal(checkListingAddress('B7')?.code, 'tooShort')
  })

  test('a real address passes, in either script', () => {
    assert.equal(checkListingAddress('Marassi, Sidi Abdel Rahman'), null)
    assert.equal(checkListingAddress('العين السخنة'), null)
    assert.equal(MIN_LOCATION_LETTERS, 3)
  })
})

describe('checkListingArea', () => {
  test('no area and no resort is refused', () => {
    assert.deepEqual(checkListingArea({}), { code: 'required', field: 'region' })
    assert.deepEqual(checkListingArea({ region: '' }), { code: 'required', field: 'region' })
  })

  test('a region alone answers it', () => {
    assert.equal(checkListingArea({ region: 'north-coast' }), null)
  })

  test('a resort alone answers it — the region is derived from it', () => {
    // resolveResortSelection sets the region from the resort. Demanding the
    // region separately would refuse a listing that names its compound and then
    // have the server fill the region in a line later.
    assert.equal(checkListingArea({ resort_id: 'e7c1…' }), null)
    assert.equal(checkListingArea({ resort_name: 'Marassi' }), null)
  })

  test('any answered area passes — the catalog check is not this module', () => {
    // normalizeRegion in db.ts refuses a value outside the catalog. Re-deciding
    // it here would mean two places to change when a region is added.
    assert.equal(checkListingArea({ region: 'somewhere-new' }), null)
  })
})

describe('checkListingPinPresence', () => {
  test('no pin is refused', () => {
    assert.deepEqual(checkListingPinPresence(null, null), { code: 'required', field: 'pin' })
    assert.equal(checkListingPinPresence(undefined, undefined)?.code, 'required')
    assert.equal(checkListingPinPresence('', '')?.code, 'required')
  })

  test('half a pin is no pin', () => {
    // A latitude with no longitude places nothing, and assertCoord would have
    // accepted the lone number without a word.
    assert.equal(checkListingPinPresence(30.9, null)?.code, 'required')
    assert.equal(checkListingPinPresence(null, 28.7)?.code, 'required')
  })

  test('zero is a coordinate — the Gulf of Guinea is a place', () => {
    // `!lat` would have refused this. The pin is checked for presence here; the
    // range check is assertCoord's and the country match is listing-geo-policy's.
    assert.equal(checkListingPinPresence(0, 0), null)
  })

  test('a string coordinate passes — that is what a form field sends', () => {
    assert.equal(checkListingPinPresence('30.9', '28.7'), null)
  })

  test('a non-number is not a pin', () => {
    assert.equal(checkListingPinPresence('abc', 28.7)?.code, 'required')
    assert.equal(checkListingPinPresence(NaN, 28.7)?.code, 'required')
  })
})

describe('checkListingPropertyType', () => {
  test('an unanswered type is refused, an answered one passes', () => {
    assert.deepEqual(checkListingPropertyType(''), { code: 'required', field: 'propertyType' })
    assert.equal(checkListingPropertyType('Chalet'), null)
  })
})

describe('checkListingPhotos', () => {
  test('no photos is refused and names the floor', () => {
    assert.deepEqual(checkListingPhotos([]), {
      code: 'tooFew',
      field: 'photos',
      min: MIN_LISTING_PHOTOS,
    })
  })

  test('an omitted or malformed images field is zero photos, not an exemption', () => {
    // The shape a client that forgot the field sends. Treating a non-array as
    // "not my business" would leave the whole rule bypassable from the API.
    assert.equal(checkListingPhotos(undefined)?.code, 'tooFew')
    assert.equal(checkListingPhotos(null)?.code, 'tooFew')
    assert.equal(checkListingPhotos('https://cdn.example.com/a.jpg')?.code, 'tooFew')
    assert.equal(checkListingPhotos({ 0: 'a.jpg' })?.code, 'tooFew')
  })

  test('empty strings in the array are not photos', () => {
    assert.equal(checkListingPhotos(['', '   '])?.code, 'tooFew')
  })

  test('one photo is enough', () => {
    assert.equal(checkListingPhotos(['data:image/jpeg;base64,AAAA']), null)
  })
})

describe('normalizeListingText', () => {
  test('collapses whitespace, strips invisibles, trims', () => {
    assert.equal(normalizeListingText('  Nile   view \n flat  '), 'Nile view flat')
    assert.equal(normalizeListingText('a​b'), 'ab')
    assert.equal(normalizeListingText(null), '')
  })
})

describe('listingCompletenessProblemMessage', () => {
  test('every problem the module can produce has a sentence', () => {
    // A message table that falls through returns undefined, and the API would
    // answer 400 with no reason at all — worse than the bug being fixed.
    const problems = [
      { code: 'required', field: 'description' },
      { code: 'required', field: 'location' },
      { code: 'required', field: 'region' },
      { code: 'required', field: 'pin' },
      { code: 'required', field: 'propertyType' },
      { code: 'letters', field: 'description' },
      { code: 'letters', field: 'location' },
      { code: 'tooShort', field: 'description', min: MIN_DESCRIPTION_LETTERS },
      { code: 'tooShort', field: 'location', min: MIN_LOCATION_LETTERS },
      { code: 'tooFew', field: 'photos', min: MIN_LISTING_PHOTOS },
    ]
    for (const problem of problems) {
      const message = listingCompletenessProblemMessage(problem)
      assert.equal(typeof message, 'string', `${problem.field}/${problem.code}`)
      assert.ok(message.length > 0, `${problem.field}/${problem.code}`)
    }
  })

  test('the pin gets its own sentence — "add a map pin" is not what you do', () => {
    assert.match(listingCompletenessProblemMessage({ code: 'required', field: 'pin' }), /map/)
  })

  test('a floor that was missed is named in the sentence', () => {
    assert.match(
      listingCompletenessProblemMessage({ code: 'tooShort', field: 'description', min: 20 }),
      /20/
    )
  })
})

describe('checkListingEdit — the hole the create rule left open', () => {
  const CURRENT = { region: 'North Coast', resort_id: null, resort_name: null, lat: 30.9, lng: 28.7 }

  test('a complete listing cannot be edited back below the bar', () => {
    // The whole point. Every required field, cleared one at a time, is refused —
    // otherwise a listing passes the create door and is emptied out afterwards.
    const clears = {
      description: { description: '' },
      location: { location: '' },
      region: { region: '' },
      pin: { lat: null },
      propertyType: { property_type: '' },
      photos: { images: [] },
    }
    for (const [field, patch] of Object.entries(clears)) {
      assert.equal(checkListingEdit(patch, CURRENT)?.field, field, `clearing ${field}`)
    }
  })

  test('an untouched field is none of the edit\'s business', () => {
    // A patch is partial by design. Judging fields the host did not send would
    // hold a price change hostage to a description the listing never had.
    assert.equal(checkListingEdit({}, {}), null)
    assert.equal(checkListingEdit({ description: undefined }, {}), null)
  })

  test('the ownership-doc-only patch the iOS app sends still goes through', () => {
    // resubmitOwnershipDoc sends PATCH { ownership_doc } and nothing else. The
    // route strips that key before the field update, so the patch arrives empty
    // — on a legacy listing with no description, judging the whole row would
    // refuse a host answering a moderator.
    assert.equal(checkListingEdit({}, { region: null, lat: null, lng: null }), null)
  })

  test('a real edit to a required field is judged by the same rules as create', () => {
    assert.equal(checkListingEdit({ description: '@'.repeat(30) }, CURRENT)?.code, 'letters')
    assert.equal(checkListingEdit({ description: 'Too short' }, CURRENT)?.code, 'tooShort')
    assert.equal(checkListingEdit({ location: '12' }, CURRENT)?.code, 'letters')
    assert.equal(
      checkListingEdit({ description: 'A bright two-bedroom chalet by the sea with a terrace' }, CURRENT),
      null
    )
  })

  test('half a pin patch is judged against the half already stored', () => {
    // Patching lat alone must not read as "no pin" when lng is in the database,
    // and clearing lat alone must not slip past because lng is still there.
    assert.equal(checkListingEdit({ lat: 31.2 }, CURRENT), null)
    assert.equal(checkListingEdit({ lat: null }, CURRENT)?.field, 'pin')
    assert.equal(checkListingEdit({ lng: '' }, CURRENT)?.field, 'pin')
  })

  test('a resort already on the listing answers a cleared region', () => {
    // resolveResortSelection derives the region from the resort, so a host who
    // swaps the region select on a listing that names a compound is not leaving
    // the listing arealess.
    const withResort = { region: 'North Coast', resort_name: 'Marassi' }
    assert.equal(checkListingEdit({ region: '' }, withResort), null)
    // …but with no resort behind it, clearing the region is refused.
    assert.equal(checkListingEdit({ region: '' }, { region: 'North Coast' })?.field, 'region')
  })

  test('clearing the resort is fine while a region remains, refused when it does not', () => {
    assert.equal(checkListingEdit({ resort_id: null, resort_name: null }, CURRENT), null)
    assert.equal(
      checkListingEdit({ resort_id: null, resort_name: null }, { region: '', resort_name: 'Marassi' })?.field,
      'region'
    )
  })

  test('replacing the photo set with an empty one is refused', () => {
    // The edit form sends `images` as a full replacement set, so this is how a
    // host would otherwise end up with a listing that has no photos at all.
    assert.equal(checkListingEdit({ images: [] }, CURRENT)?.code, 'tooFew')
    assert.equal(checkListingEdit({ images: ['https://cdn.example.com/a.jpg'] }, CURRENT), null)
  })

  test('validateListingEdit answers with a sentence, or null', () => {
    assert.equal(validateListingEdit({ description: 'ok now, a proper description of the place' }, CURRENT), null)
    assert.match(validateListingEdit({ images: [] }, CURRENT), /photo/)
  })
})
