// Unit tests for src/lib/local/resort-core.ts — the resort naming rules.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. resort-core.ts has no relative imports, which is what makes
// it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  REGION_VALUES,
  isRegion,
  MAX_RESORT_NAME,
  normalizeResortName,
  resortSlug,
  editDistance,
  suggestResortMatches,
} from '../../src/lib/local/resort-core.ts'

describe('REGION_VALUES', () => {
  test('is the closed set a resort may belong to', () => {
    assert.deepEqual([...REGION_VALUES], ['North Coast', 'Ain Sokhna', 'El Gouna', 'Cairo'])
  })

  test('isRegion accepts members and rejects everything else', () => {
    assert.equal(isRegion('North Coast'), true)
    assert.equal(isRegion('north coast'), false, 'case-sensitive: it is a stored value, not user input')
    assert.equal(isRegion('Alexandria'), false)
    assert.equal(isRegion(null), false)
    assert.equal(isRegion(42), false)
  })
})

describe('normalizeResortName', () => {
  test('trims and collapses internal whitespace', () => {
    assert.equal(normalizeResortName('  Hacienda   Bay  '), 'Hacienda Bay')
    assert.equal(normalizeResortName('Marassi\n\tNorth'), 'Marassi North')
  })

  test('preserves the host capitalisation and punctuation', () => {
    // The raw text is shown to guests as typed until an admin approves a spelling.
    assert.equal(normalizeResortName('SouthMed'), 'SouthMed')
    assert.equal(normalizeResortName("Marina D'Or"), "Marina D'Or")
  })

  test('returns null for anything blank — the "host left it empty" signal', () => {
    assert.equal(normalizeResortName(''), null)
    assert.equal(normalizeResortName('   '), null)
    assert.equal(normalizeResortName('\n\t'), null)
    assert.equal(normalizeResortName(null), null)
    assert.equal(normalizeResortName(undefined), null)
    assert.equal(normalizeResortName(123), null, 'non-strings are not coerced')
  })

  test('caps length so a paste accident cannot fill the column', () => {
    const long = 'a'.repeat(500)
    assert.equal(normalizeResortName(long).length, MAX_RESORT_NAME)
  })
})

describe('resortSlug', () => {
  test('collapses the variants that must share one catalog row', () => {
    // This is the whole point: these four are the same resort.
    for (const v of ['Amouage', 'amouage', '  AMOUAGE  ', 'Amouage.']) {
      assert.equal(resortSlug(v), 'amouage', `"${v}" must slug to amouage`)
    }
  })

  test('strips diacritics', () => {
    assert.equal(resortSlug('Café Rôtisserie'), 'cafe-rotisserie')
  })

  test('turns punctuation and spaces into single hyphens', () => {
    assert.equal(resortSlug('Stella Di Mare'), 'stella-di-mare')
    assert.equal(resortSlug("Marina D'Or"), 'marina-d-or')
    assert.equal(resortSlug('Abu  Tig   Marina'), 'abu-tig-marina')
    assert.equal(resortSlug('El-Gouna / Reef'), 'el-gouna-reef')
  })

  test('returns empty string when there is nothing usable', () => {
    // Callers must treat '' as "no name", never as a real slug.
    assert.equal(resortSlug(''), '')
    assert.equal(resortSlug('   '), '')
    assert.equal(resortSlug('!!!'), '')
    assert.equal(resortSlug(null), '')
    assert.equal(resortSlug(undefined), '')
  })

  test('is idempotent — slugging a slug changes nothing', () => {
    const once = resortSlug('Sidi Abdel Rahman')
    assert.equal(resortSlug(once), once)
  })

  test('caps length', () => {
    assert.ok(resortSlug('x'.repeat(500)).length <= MAX_RESORT_NAME)
  })
})

describe('editDistance', () => {
  test('identical strings are distance 0', () => {
    assert.equal(editDistance('amouage', 'amouage'), 0)
  })

  test('the misspelling this feature exists for is distance 1', () => {
    assert.equal(editDistance('amouge', 'amouage'), 1)
  })

  test('handles empty strings', () => {
    assert.equal(editDistance('', ''), 0)
    assert.equal(editDistance('', 'abc'), 3)
    assert.equal(editDistance('abc', ''), 3)
  })

  test('is symmetric', () => {
    assert.equal(editDistance('marassi', 'marasi'), editDistance('marasi', 'marassi'))
  })

  test('counts substitutions, insertions and deletions alike', () => {
    assert.equal(editDistance('cat', 'bat'), 1) // substitute
    assert.equal(editDistance('cat', 'cart'), 1) // insert
    assert.equal(editDistance('cart', 'cat'), 1) // delete
    assert.equal(editDistance('kitten', 'sitting'), 3) // the classic
  })
})

describe('suggestResortMatches', () => {
  const CATALOG = [
    { id: 'r1', name: 'Amouage', slug: 'amouage' },
    { id: 'r2', name: 'Marassi', slug: 'marassi' },
    { id: 'r3', name: 'Fouka Bay', slug: 'fouka-bay' },
    { id: 'r4', name: 'Hacienda Bay', slug: 'hacienda-bay' },
  ]

  test('ranks the intended resort first for a typo', () => {
    const out = suggestResortMatches('amouge', CATALOG)
    assert.equal(out[0].id, 'r1')
    assert.equal(out[0].distance, 1)
  })

  test('an exact match is distance 0 and ranks first', () => {
    const out = suggestResortMatches('Marassi', CATALOG)
    assert.equal(out[0].id, 'r2')
    assert.equal(out[0].distance, 0)
  })

  test('excludes anything beyond maxDistance', () => {
    // 'fouka-bay' vs 'hacienda-bay' are far apart; nothing should match a
    // completely unrelated name.
    assert.deepEqual(suggestResortMatches('Totally Different Place', CATALOG), [])
  })

  test('honours an explicit maxDistance', () => {
    assert.equal(suggestResortMatches('amouge', CATALOG, { maxDistance: 0 }).length, 0)
    assert.equal(suggestResortMatches('amouge', CATALOG, { maxDistance: 1 }).length, 1)
  })

  test('honours limit', () => {
    const wide = suggestResortMatches('bay', CATALOG, { maxDistance: 20, limit: 2 })
    assert.equal(wide.length, 2)
  })

  test('empty or unusable input yields no suggestions', () => {
    assert.deepEqual(suggestResortMatches('', CATALOG), [])
    assert.deepEqual(suggestResortMatches('   ', CATALOG), [])
    assert.deepEqual(suggestResortMatches(null, CATALOG), [])
  })

  test('empty catalog yields no suggestions', () => {
    assert.deepEqual(suggestResortMatches('Amouage', []), [])
  })

  test('ties break deterministically on name', () => {
    // Two entries equidistant from the query must always come back in the same
    // order, or the /ops merge dialog reshuffles between renders.
    const tied = [
      { id: 'b', name: 'Bbb', slug: 'bbb' },
      { id: 'a', name: 'Aaa', slug: 'aaa' },
    ]
    const out = suggestResortMatches('xxx', tied, { maxDistance: 5 })
    assert.deepEqual(out.map((r) => r.name), ['Aaa', 'Bbb'])
  })
})
