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
  MIN_RESORT_NAME_LETTERS,
  normalizeResortName,
  checkResortName,
  isValidResortName,
  validateResortName,
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

describe('checkResortName', () => {
  // The bug: the create form asked only that the box was non-blank, so a host
  // could pick "Other — not listed", type `@@@@@` and publish. The name has no
  // slug, and a name with no slug was read downstream as "no resort chosen" —
  // the answer was discarded on save.
  test('refuses a name made only of symbols — the bug this rule exists for', () => {
    for (const junk of ['@@@@@', '!!!!!', '-----', '###', '???', '...', '***']) {
      assert.deepEqual(checkResortName(junk), { code: 'letters' }, `"${junk}" must be refused`)
    }
  })

  test('refuses a name made only of digits, in either numeral system', () => {
    assert.deepEqual(checkResortName('12345'), { code: 'letters' })
    assert.deepEqual(checkResortName('٠١٢٣'), { code: 'letters' })
    assert.deepEqual(checkResortName('90 90 90'), { code: 'letters' })
  })

  test('refuses invisible characters, which survive a trim and render as nothing', () => {
    assert.deepEqual(checkResortName('\u200b\u200b'), { code: 'required' })
    assert.deepEqual(checkResortName('\ufeff \u00ad'), { code: 'required' })
  })

  test('says `required` for blank, before it says anything about letters', () => {
    assert.deepEqual(checkResortName(''), { code: 'required' })
    assert.deepEqual(checkResortName('   '), { code: 'required' })
    assert.deepEqual(checkResortName(null), { code: 'required' })
    assert.deepEqual(checkResortName(42), { code: 'required' }, 'non-strings are not coerced')
  })

  test('says `letters` before `tooShort` — the fix for `@@@@@` is words, not a sixth @', () => {
    assert.deepEqual(checkResortName('@'), { code: 'letters' })
    assert.deepEqual(checkResortName('A'), { code: 'tooShort' })
  })

  // The half that matters more: a rule that turns away a real compound is the
  // worse failure — the host's only alternative is to leave the resort blank.
  test('accepts the names hosts actually type', () => {
    for (const name of [
      'Marassi',
      'Hacienda Bay',
      'Marina D\'Or',
      'Marassi (North)',
      'Sa7el Chalet',        // franco-arabic writes real words with numerals
      'La Vista 7',
      '90 Avenue',
      'هاسيندا باي',          // Arabic — the catalog is Egypt-first
      'Il Monte Galala',
    ]) {
      assert.equal(checkResortName(name), null, `"${name}" must be accepted`)
      assert.equal(isValidResortName(name), true)
    }
  })

  test('MIN_RESORT_NAME_LETTERS is the floor, counted in any script', () => {
    assert.equal(MIN_RESORT_NAME_LETTERS, 2)
    assert.deepEqual(checkResortName('م'), { code: 'tooShort' })
    assert.equal(checkResortName('م ج'), null, 'two letters, split by a space, still counts')
  })

  test('validateResortName turns a problem into the sentence the API returns', () => {
    assert.match(validateResortName('@@@@@'), /symbols or numbers/)
    assert.match(validateResortName(''), /resort or compound name/)
    assert.equal(validateResortName('Marassi'), null)
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
