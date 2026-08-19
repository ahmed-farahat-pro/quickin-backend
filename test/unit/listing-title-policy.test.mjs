// Unit tests for src/lib/local/listing-title-policy.ts — the rule every path
// that sets a listing title clears, in BOTH repos: `createListing` and the title
// branch of the edit patch (web and backend alike), the /host create + edit forms
// and the dashboard wizard's zod schema on the web, and through the backend every
// title the iOS and Android apps send. The file is byte-identical across the two
// repos; check-listing-title-policy-parity.mjs is what keeps it that way.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. listing-title-policy.ts has no imports, which is what
// makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TITLE_LENGTH,
  MIN_TITLE_LETTERS,
  checkListingTitle,
  isValidListingTitle,
  listingTitleProblemMessage,
  normalizeListingTitle,
  validateListingTitle,
} from '../../src/lib/local/listing-title-policy.ts'

describe('checkListingTitle — the bug this policy exists for', () => {
  test('a title of only special characters is refused', () => {
    // Each of these published a listing whose name on the explore grid, in
    // search results and in the host's booking request was literally this.
    for (const title of ['@@@@@', '!!!!!', '#$%^&', '.....', '-----', '???']) {
      assert.deepEqual(checkListingTitle(title), { code: 'letters' }, title)
    }
  })

  test('a title of only digits is refused too', () => {
    for (const title of ['12345', '٠١٢٣٤', '2024']) {
      assert.deepEqual(checkListingTitle(title), { code: 'letters' }, title)
    }
  })

  test('symbols mixed with a real title are fine — the rule is letters, not purity', () => {
    for (const title of ['Nile-view flat (2BR)', '★ Sahel chalet ★', 'Villa #4 — sea view']) {
      assert.equal(checkListingTitle(title), null, title)
    }
  })
})

describe('checkListingTitle — the titles this app is built for', () => {
  test('Arabic titles pass', () => {
    assert.equal(checkListingTitle('شقة بإطلالة على النيل'), null)
  })

  test('Franco-Arabic passes — numerals stand in for letters, but not for all of them', () => {
    assert.equal(checkListingTitle('Sa7el chalet'), null)
    assert.equal(checkListingTitle('Sha2a fel Gouna'), null)
  })

  test('an emoji is not a letter', () => {
    assert.deepEqual(checkListingTitle('🏖️🏖️🏖️'), { code: 'letters' })
  })
})

describe('checkListingTitle — the other refusals', () => {
  test('empty, blank and whitespace-only are `required`', () => {
    for (const title of ['', '   ', '\t\n', null, undefined]) {
      assert.deepEqual(checkListingTitle(title), { code: 'required' })
    }
  })

  test('a title made only of invisible characters is `required`, not accepted', () => {
    // They survive .trim() and render as nothing — a listing named with them
    // would show an empty card. Zero-width space, BOM, bidi marks, soft hyphen.
    assert.deepEqual(checkListingTitle('\u200B\uFEFF\u202A\u00AD'), { code: 'required' })
  })

  test('fewer than MIN_TITLE_LETTERS letters is `tooShort`', () => {
    assert.deepEqual(checkListingTitle('A5'), { code: 'tooShort' })
    assert.deepEqual(checkListingTitle('B'), { code: 'tooShort' })
    // The boundary itself is accepted.
    assert.equal(checkListingTitle('Flat'.slice(0, MIN_TITLE_LETTERS)), null)
  })

  test('over MAX_TITLE_LENGTH is `tooLong`, counted in code points', () => {
    assert.equal(checkListingTitle('a'.repeat(MAX_TITLE_LENGTH)), null)
    assert.deepEqual(checkListingTitle('a'.repeat(MAX_TITLE_LENGTH + 1)), { code: 'tooLong' })
    // 200 Arabic characters is 200 characters, not 400.
    assert.equal(checkListingTitle('ش'.repeat(MAX_TITLE_LENGTH)), null)
  })

  test('`letters` is reported before `tooShort` — say what is actually wrong', () => {
    // `@@` is both letterless and short; being told to add a third `@` would be
    // advice that leads nowhere.
    assert.deepEqual(checkListingTitle('@@'), { code: 'letters' })
  })
})

describe('normalizeListingTitle', () => {
  test('trims, collapses whitespace runs and drops invisibles', () => {
    assert.equal(normalizeListingTitle('  Nile   view  '), 'Nile view')
    assert.equal(normalizeListingTitle('Sea\u200Bside\tvilla'), 'Seaside villa')
    assert.equal(normalizeListingTitle('\nChalet\n'), 'Chalet')
  })

  test('non-strings become the empty string rather than "null"', () => {
    assert.equal(normalizeListingTitle(null), '')
    assert.equal(normalizeListingTitle(undefined), '')
  })

  test('the check normalizes for you — a padded good title still passes', () => {
    assert.equal(checkListingTitle('   Gouna   chalet   '), null)
  })
})

describe('messages', () => {
  test('every problem code has a sentence, and it names the limit it enforces', () => {
    for (const code of ['required', 'letters', 'tooShort', 'tooLong']) {
      const msg = listingTitleProblemMessage({ code })
      assert.equal(typeof msg, 'string')
      assert.ok(msg.length > 0, code)
    }
    assert.match(listingTitleProblemMessage({ code: 'tooShort' }), new RegExp(String(MIN_TITLE_LETTERS)))
    assert.match(listingTitleProblemMessage({ code: 'tooLong' }), new RegExp(String(MAX_TITLE_LENGTH)))
  })

  test('validateListingTitle answers null for a good title and a sentence for a bad one', () => {
    assert.equal(validateListingTitle('Seaside chalet'), null)
    assert.equal(typeof validateListingTitle('!!!!!'), 'string')
  })
})

describe('isValidListingTitle — the submit-button gate', () => {
  test('agrees with checkListingTitle', () => {
    assert.equal(isValidListingTitle('Seaside chalet'), true)
    assert.equal(isValidListingTitle('!!!!!'), false)
    assert.equal(isValidListingTitle(''), false)
  })
})
