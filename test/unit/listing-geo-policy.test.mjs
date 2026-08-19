// Unit tests for src/lib/local/listing-geo-policy.ts — the check that keeps a
// listing's map pin in the same country (and curated area) as the words the host
// typed. This project's copy backs the `pin_warning` the listing routes answer
// with; the web project's copy (same file, same tests) backs the warning under
// the host form's map and the badge in /ops.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. listing-geo-policy.ts has no imports, which is what makes
// it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  COUNTRY_BOXES,
  REGION_BOXES,
  canonicalCountry,
  canonicalRegion,
  checkListingPin,
  isInsideBox,
  isListingPinMismatch,
  listingPinBadgeLabel,
  listingPinProblemMessage,
  readPin,
} from '../../src/lib/local/listing-geo-policy.ts'

// The coordinates the reported bug used, plus the real places they stand for.
const PORTO_MARINA = { lat: 30.8318, lng: 28.9034 } // Porto Marina, North Coast
const BERLIN = { lat: 52.52, lng: 13.405 }
const CAIRO = { lat: 30.0444, lng: 31.2357 }
const SOKHNA = { lat: 29.6, lng: 32.32 }
const EL_GOUNA = { lat: 27.396, lng: 33.678 }
const DUBAI = { lat: 25.2048, lng: 55.2708 }

describe('checkListingPin — the bug this policy exists for', () => {
  test('Egypt + North Coast with a pin in Germany is flagged as outside the country', () => {
    const problem = checkListingPin({ ...BERLIN, country: 'Egypt', region: 'North Coast' })
    assert.deepEqual(problem, { code: 'outsideCountry', scope: 'Egypt' })
  })

  test('the same listing pinned at Porto Marina is accepted', () => {
    assert.equal(checkListingPin({ ...PORTO_MARINA, country: 'Egypt', region: 'North Coast' }), null)
  })

  test('an Egyptian pin in the wrong curated area is flagged as outside the region', () => {
    const problem = checkListingPin({ ...CAIRO, country: 'Egypt', region: 'North Coast' })
    assert.deepEqual(problem, { code: 'outsideRegion', scope: 'North Coast' })
  })

  test('the country is named before the region — the bigger mistake wins', () => {
    // Berlin is outside BOTH Egypt and North Coast; only the country is reported.
    const problem = checkListingPin({ ...BERLIN, country: 'Egypt', region: 'North Coast' })
    assert.equal(problem?.code, 'outsideCountry')
  })
})

describe('each curated area accepts its own place and refuses the others', () => {
  const cases = [
    ['North Coast', PORTO_MARINA],
    ['Ain Sokhna', SOKHNA],
    ['El Gouna', EL_GOUNA],
    ['Cairo', CAIRO],
  ]
  for (const [region, pin] of cases) {
    test(`${region} accepts its own pin`, () => {
      assert.equal(checkListingPin({ ...pin, country: 'Egypt', region }), null)
    })
    for (const [other, otherPin] of cases) {
      if (other === region) continue
      test(`${region} refuses a pin in ${other}`, () => {
        assert.deepEqual(checkListingPin({ ...otherPin, country: 'Egypt', region }), {
          code: 'outsideRegion',
          scope: region,
        })
      })
    }
  }

  test('Greater Cairo counts as Cairo — 6th of October and New Cairo are not flagged', () => {
    assert.equal(checkListingPin({ lat: 29.9403, lng: 30.9219, country: 'Egypt', region: 'Cairo' }), null)
    assert.equal(checkListingPin({ lat: 30.0301, lng: 31.4712, country: 'Egypt', region: 'Cairo' }), null)
  })

  test('the whole Alexandria → Marsa Matrouh strip counts as North Coast', () => {
    assert.equal(checkListingPin({ lat: 31.2001, lng: 29.9187, country: 'Egypt', region: 'North Coast' }), null)
    assert.equal(checkListingPin({ lat: 31.3543, lng: 27.2373, country: 'Egypt', region: 'North Coast' }), null)
  })
})

describe('other countries in the host form', () => {
  test('a Dubai pin is accepted for the United Arab Emirates', () => {
    assert.equal(checkListingPin({ ...DUBAI, country: 'United Arab Emirates' }), null)
  })

  test('a Dubai pin on an Egyptian listing is flagged', () => {
    assert.deepEqual(checkListingPin({ ...DUBAI, country: 'Egypt' }), {
      code: 'outsideCountry',
      scope: 'Egypt',
    })
  })

  test('every country the form offers has a box', () => {
    for (const name of [
      'Egypt', 'Saudi Arabia', 'United Arab Emirates', 'Kuwait', 'Qatar',
      'Bahrain', 'Oman', 'Jordan', 'Lebanon', 'Morocco',
    ]) {
      assert.ok(COUNTRY_BOXES[name], `${name} has no box`)
    }
  })

  test('every box is well formed — low corner really is the low corner', () => {
    for (const [name, box] of Object.entries({ ...COUNTRY_BOXES, ...REGION_BOXES })) {
      assert.ok(box.south < box.north, `${name}: south is not below north`)
      assert.ok(box.west < box.east, `${name}: west is not left of east`)
      assert.ok(Math.abs(box.south) <= 90 && Math.abs(box.north) <= 90, `${name}: latitude out of range`)
      assert.ok(Math.abs(box.west) <= 180 && Math.abs(box.east) <= 180, `${name}: longitude out of range`)
    }
  })

  test("Morocco's negative longitudes are handled", () => {
    assert.equal(checkListingPin({ lat: 31.6295, lng: -7.9811, country: 'Morocco' }), null) // Marrakesh
    assert.deepEqual(checkListingPin({ lat: 31.6295, lng: 7.9811, country: 'Morocco' }), {
      code: 'outsideCountry',
      scope: 'Morocco',
    })
  })
})

describe('silence when we cannot honestly judge', () => {
  test('no pin at all is not a problem — the field is optional', () => {
    assert.equal(checkListingPin({ country: 'Egypt', region: 'North Coast' }), null)
    assert.equal(checkListingPin({ lat: null, lng: null, country: 'Egypt' }), null)
    assert.equal(checkListingPin({ lat: '', lng: '', country: 'Egypt' }), null)
    assert.equal(checkListingPin({ lat: 30.0, lng: undefined, country: 'Egypt' }), null)
  })

  test('a country we have no box for is never flagged', () => {
    assert.equal(checkListingPin({ ...BERLIN, country: 'Germany' }), null)
    assert.equal(checkListingPin({ ...BERLIN, country: '' }), null)
    assert.equal(checkListingPin({ ...BERLIN }), null)
  })

  test('a region we have no box for is never flagged', () => {
    assert.equal(checkListingPin({ ...CAIRO, country: 'Egypt', region: 'Somewhere Else' }), null)
    assert.equal(checkListingPin({ ...CAIRO, country: 'Egypt', region: '' }), null)
  })

  test('unparseable coordinates are treated as no pin, not as a mismatch', () => {
    assert.equal(checkListingPin({ lat: 'abc', lng: 'def', country: 'Egypt' }), null)
    assert.equal(checkListingPin({ lat: Number.NaN, lng: 12, country: 'Egypt' }), null)
  })
})

describe('impossible coordinates', () => {
  test('a latitude past the pole is reported as itself, not as a country mismatch', () => {
    assert.deepEqual(checkListingPin({ lat: 999, lng: 31.2, country: 'Egypt' }), {
      code: 'outOfRange',
      scope: '',
    })
  })

  test('a longitude past the antimeridian is out of range', () => {
    assert.deepEqual(checkListingPin({ lat: 30.0, lng: 181, country: 'Egypt' }), {
      code: 'outOfRange',
      scope: '',
    })
  })

  test('the poles and the antimeridian themselves are in range', () => {
    // Absurd for a listing, but they are real coordinates — the country box is
    // what refuses them, which is the message the host can act on.
    assert.equal(checkListingPin({ lat: 90, lng: 180 })?.code, undefined)
  })
})

describe('names hosts and old rows actually carry', () => {
  test('country aliases and casing resolve', () => {
    assert.equal(canonicalCountry('egypt'), 'Egypt')
    assert.equal(canonicalCountry('  EGYPT '), 'Egypt')
    assert.equal(canonicalCountry('UAE'), 'United Arab Emirates')
    assert.equal(canonicalCountry('KSA'), 'Saudi Arabia')
    assert.equal(canonicalCountry('Germany'), '')
    assert.equal(canonicalCountry(null), '')
  })

  test('region aliases and casing resolve', () => {
    assert.equal(canonicalRegion('north coast'), 'North Coast')
    assert.equal(canonicalRegion('Sahel'), 'North Coast')
    assert.equal(canonicalRegion('Sokhna'), 'Ain Sokhna')
    assert.equal(canonicalRegion('gouna'), 'El Gouna')
    assert.equal(canonicalRegion('Greater Cairo'), 'Cairo')
    assert.equal(canonicalRegion('Aswan'), '')
  })

  test('an aliased country is still checked', () => {
    assert.deepEqual(checkListingPin({ ...BERLIN, country: 'egypt' }), {
      code: 'outsideCountry',
      scope: 'Egypt',
    })
  })
})

describe('helpers the callers use', () => {
  test('readPin returns numbers for numeric strings the API receives', () => {
    assert.deepEqual(readPin('30.0444', '31.2357'), { lat: 30.0444, lng: 31.2357 })
    assert.equal(readPin('30.0444', null), null)
  })

  test('isInsideBox is inclusive on every edge', () => {
    const box = { south: 10, west: 20, north: 30, east: 40 }
    assert.equal(isInsideBox(10, 20, box), true)
    assert.equal(isInsideBox(30, 40, box), true)
    assert.equal(isInsideBox(30.0001, 40, box), false)
  })

  test('isListingPinMismatch is the boolean form', () => {
    assert.equal(isListingPinMismatch({ ...BERLIN, country: 'Egypt' }), true)
    assert.equal(isListingPinMismatch({ ...CAIRO, country: 'Egypt' }), false)
  })

  test('messages name the field the host should fix', () => {
    assert.match(
      listingPinProblemMessage({ code: 'outsideCountry', scope: 'Egypt' }),
      /outside Egypt.*country/,
    )
    assert.match(
      listingPinProblemMessage({ code: 'outsideRegion', scope: 'North Coast' }),
      /outside North Coast.*area/,
    )
    assert.equal(listingPinProblemMessage(null), '')
  })

  test('the /ops badge is empty for a good pin and specific for a bad one', () => {
    assert.equal(listingPinBadgeLabel({ ...PORTO_MARINA, country: 'Egypt', region: 'North Coast' }), '')
    assert.equal(listingPinBadgeLabel({ ...BERLIN, country: 'Egypt' }), 'Pin outside Egypt')
    assert.equal(listingPinBadgeLabel({ ...CAIRO, country: 'Egypt', region: 'El Gouna' }), 'Pin outside El Gouna')
    assert.equal(listingPinBadgeLabel({ lat: 999, lng: 0, country: 'Egypt' }), 'Pin: invalid')
  })
})
