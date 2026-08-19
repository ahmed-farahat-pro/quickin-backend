// Unit tests for src/lib/local/listing-review-note-core.ts — the operator's note on
// a rejected listing.
//
// What these are really guarding: the note used to be spent on a notification body
// and then discarded, so a host saw "Rejected" with no reason and no way to recover
// one. The note is now a stored value, which means the thing worth breaking a build
// over is that "no note" and "an empty note" normalize to the SAME null — a host
// surface must never render a blank reason box where it could have shown its generic
// guidance, and the column must never fill up with '' and '   ' rows that read as a
// reason to every `note ? … : …` check downstream.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. listing-review-note-core.ts has no relative imports, which is
// what makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_LISTING_REVIEW_NOTE_CHARS,
  listingRejectionMessage,
  normalizeListingReviewNote,
} from '../../src/lib/local/listing-review-note-core.ts'

describe('normalizeListingReviewNote', () => {
  test('keeps a real note as written', () => {
    assert.equal(
      normalizeListingReviewNote('The ownership document is unreadable.'),
      'The ownership document is unreadable.',
    )
  })

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeListingReviewNote('  Photos are stock images.\n '), 'Photos are stock images.')
  })

  test('treats every kind of "nothing" as no note at all', () => {
    // The rejection is optional-note by design, so all of these must land on the
    // same null — anything else and a host surface renders an empty reason.
    for (const blank of ['', '   ', '\n\n', '\t', null, undefined, 0, false, {}, []]) {
      assert.equal(normalizeListingReviewNote(blank), null, `expected null for ${JSON.stringify(blank)}`)
    }
  })

  test('collapses pasted blank-line runs but keeps single breaks', () => {
    assert.equal(
      normalizeListingReviewNote('Fix the title.\n\n\n\nFix the photos.'),
      'Fix the title.\n\nFix the photos.',
    )
    assert.equal(normalizeListingReviewNote('One\nTwo'), 'One\nTwo')
  })

  test('normalizes CRLF so a Windows-pasted note is not counted twice', () => {
    assert.equal(normalizeListingReviewNote('One\r\nTwo'), 'One\nTwo')
  })

  test('truncates an over-long note rather than failing the rejection', () => {
    const long = 'x'.repeat(MAX_LISTING_REVIEW_NOTE_CHARS + 250)
    const out = normalizeListingReviewNote(long)
    assert.equal(out.length, MAX_LISTING_REVIEW_NOTE_CHARS)
  })

  test('a note exactly at the cap is untouched', () => {
    const exact = 'y'.repeat(MAX_LISTING_REVIEW_NOTE_CHARS)
    assert.equal(normalizeListingReviewNote(exact), exact)
  })

  test('is idempotent — storing a normalized note and re-normalizing changes nothing', () => {
    const once = normalizeListingReviewNote('  Fix the title.\n\n\n\nFix the photos.  ')
    assert.equal(normalizeListingReviewNote(once), once)
  })
})

describe('listingRejectionMessage', () => {
  test('quotes the reason when one was given', () => {
    assert.equal(
      listingRejectionMessage('Sea View Chalet', 'The ownership document is unreadable.'),
      '"Sea View Chalet" wasn\'t approved: The ownership document is unreadable.',
    )
  })

  test('falls back to generic guidance when no reason was given', () => {
    assert.equal(
      listingRejectionMessage('Sea View Chalet', '   '),
      '"Sea View Chalet" wasn\'t approved this time. Please review it and resubmit.',
    )
  })

  test('names an untitled listing rather than quoting an empty string', () => {
    assert.match(listingRejectionMessage(null, null), /^"Your listing" wasn't approved/)
    assert.match(listingRejectionMessage('   ', null), /^"Your listing" wasn't approved/)
  })
})
