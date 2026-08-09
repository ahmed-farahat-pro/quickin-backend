// Unit tests for src/lib/local/disputes-core.ts — the rules behind a guest
// raising an issue about a stay and /ops working it through.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. disputes-core.ts has no relative imports, which is what
// makes it loadable here at all. See README → Testing.
//
// The things worth locking down are the ones a later edit could quietly break:
// which bookings are disputable, that `closed` is terminal, and that the
// validators produce messages a guest can act on.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISPUTE_CATEGORIES,
  isDisputeCategory,
  normalizeCategory,
  categoryLabel,
  DISPUTE_STATUSES,
  normalizeStatus,
  statusLabel,
  statusTone,
  needsAction,
  canTransition,
  transitionError,
  DISPUTABLE_BOOKING_STATUSES,
  canDisputeBooking,
  bookingIneligibleReason,
  MIN_DESCRIPTION_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_PHOTOS,
  MAX_PHOTO_CHARS,
  isDisputeInputError,
  normalizeDescription,
  normalizePhotos,
  normalizeNote,
  validateFiling,
  disputeReference,
  eventSummary,
} from '../../src/lib/local/disputes-core.ts'

describe('categories', () => {
  test('the catalog is the eight agreed options', () => {
    assert.equal(DISPUTE_CATEGORIES.length, 8)
    assert.deepEqual(DISPUTE_CATEGORIES.map((c) => c.key), [
      'not_as_described', 'cleanliness', 'checkin', 'host_unresponsive',
      'safety', 'overcharged', 'damage', 'other',
    ])
  })

  test('every category has a human label', () => {
    for (const c of DISPUTE_CATEGORIES) assert.match(c.label, /\w/)
    assert.equal(categoryLabel('cleanliness'), 'Cleanliness')
  })

  test('junk is rejected on the way in', () => {
    for (const v of ['', null, undefined, 'nonsense', 'OTHER']) {
      assert.equal(isDisputeCategory(v), false, `should reject ${JSON.stringify(v)}`)
    }
  })

  test('but a row written by a newer deploy reads back as other, not a crash', () => {
    // The /ops queue must not 500 because a future version recorded a category
    // this build has never heard of.
    assert.equal(normalizeCategory('brand_new_category'), 'other')
    assert.equal(categoryLabel('brand_new_category'), 'Other')
  })
})

describe('the lifecycle', () => {
  test('four states', () => {
    assert.deepEqual([...DISPUTE_STATUSES], ['open', 'in_review', 'resolved', 'closed'])
  })

  test('unknown statuses read as open', () => {
    assert.equal(normalizeStatus('something'), 'open')
    assert.equal(normalizeStatus(null), 'open')
  })

  test('labels and tones cover every state', () => {
    for (const s of DISPUTE_STATUSES) {
      assert.match(statusLabel(s), /\w/)
      assert.ok(['amber', 'blue', 'green', 'grey'].includes(statusTone(s)))
    }
    assert.equal(statusLabel('in_review'), 'In review')
  })

  test('open and in_review need action; resolved and closed do not', () => {
    assert.equal(needsAction('open'), true)
    assert.equal(needsAction('in_review'), true)
    assert.equal(needsAction('resolved'), false)
    assert.equal(needsAction('closed'), false)
  })

  test('the normal path is allowed', () => {
    assert.ok(canTransition('open', 'in_review'))
    assert.ok(canTransition('in_review', 'resolved'))
    assert.ok(canTransition('resolved', 'closed'))
  })

  test('a resolved dispute can be reopened', () => {
    // A guest comes back saying it was never actually fixed.
    assert.ok(canTransition('resolved', 'in_review'))
    assert.ok(canTransition('resolved', 'open'))
  })

  test('closed is terminal', () => {
    // This is what makes the queue trustworthy — if closed could reopen, "closed"
    // would mean nothing.
    for (const to of DISPUTE_STATUSES) {
      assert.equal(canTransition('closed', to), false, `closed → ${to} must be refused`)
    }
    assert.match(transitionError('closed', 'open'), /cannot be reopened/i)
  })

  test('a no-op transition is refused', () => {
    // Allowing it would write a history row that says nothing happened.
    assert.equal(canTransition('open', 'open'), false)
    assert.match(transitionError('open', 'open'), /already open/i)
  })

  test('a refusal always explains itself', () => {
    assert.equal(transitionError('open', 'in_review'), null)
    for (const [from, to] of [['closed', 'open'], ['open', 'open'], ['closed', 'resolved']]) {
      assert.match(transitionError(from, to) ?? '', /\w/)
    }
  })
})

describe('which bookings can be disputed', () => {
  test('confirmed and completed — before, during and after the stay', () => {
    assert.deepEqual([...DISPUTABLE_BOOKING_STATUSES], ['confirmed', 'completed'])
    assert.equal(canDisputeBooking('confirmed'), true)
    assert.equal(canDisputeBooking('completed'), true)
  })

  test('pending is not: nothing has been agreed yet', () => {
    assert.equal(canDisputeBooking('pending'), false)
    assert.match(bookingIneligibleReason('pending'), /not been confirmed/i)
  })

  test('cancelled and rejected are not: no stay happened', () => {
    assert.equal(canDisputeBooking('cancelled'), false)
    assert.equal(canDisputeBooking('rejected'), false)
    assert.match(bookingIneligibleReason('cancelled'), /cancelled/i)
  })

  test('junk is not disputable', () => {
    for (const v of ['', null, undefined, 'CONFIRMED']) assert.equal(canDisputeBooking(v), false)
  })
})

describe('the description', () => {
  test('empty is refused with a plain ask', () => {
    assert.throws(() => normalizeDescription(''), (e) => isDisputeInputError(e) && /describe/i.test(e.message))
  })

  test('too short is refused, and says how short', () => {
    assert.throws(
      () => normalizeDescription('it was bad'),
      (e) => isDisputeInputError(e) && e.message.includes(String(MIN_DESCRIPTION_CHARS)),
    )
  })

  test('a real description passes and is trimmed', () => {
    const text = '   The AC in the living room did not work for three nights.   '
    assert.equal(normalizeDescription(text), text.trim())
  })

  test('an over-long description is bounded rather than refused', () => {
    // Someone who pasted their whole diary still gets their dispute filed.
    const out = normalizeDescription('x'.repeat(MAX_DESCRIPTION_CHARS + 500))
    assert.equal(out.length, MAX_DESCRIPTION_CHARS)
  })
})

describe('photos', () => {
  test('optional — none is fine', () => {
    assert.deepEqual(normalizePhotos(undefined), [])
    assert.deepEqual(normalizePhotos(null), [])
    assert.deepEqual(normalizePhotos('not an array'), [])
  })

  test('data URLs and http(s) are kept', () => {
    const ok = ['data:image/jpeg;base64,AAAA', 'https://example.com/a.jpg']
    assert.deepEqual(normalizePhotos(ok), ok)
  })

  test('one bad attachment does not lose the others', () => {
    // A guest who just typed a long complaint should not have it rejected
    // because one of four files was odd.
    const mixed = ['data:image/png;base64,AAAA', 'javascript:alert(1)', '', 'https://example.com/b.jpg']
    assert.deepEqual(normalizePhotos(mixed), ['data:image/png;base64,AAAA', 'https://example.com/b.jpg'])
  })

  test('an oversized photo is dropped', () => {
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_PHOTO_CHARS)
    assert.deepEqual(normalizePhotos([huge]), [])
  })

  test('the count is capped', () => {
    const many = Array.from({ length: MAX_PHOTOS + 4 }, (_, i) => `data:image/png;base64,${i}`)
    assert.equal(normalizePhotos(many).length, MAX_PHOTOS)
  })
})

describe('notes', () => {
  test('blank becomes null, not an empty string', () => {
    // A history row with an empty note reads differently from one with no note.
    assert.equal(normalizeNote(''), null)
    assert.equal(normalizeNote('   '), null)
    assert.equal(normalizeNote(undefined), null)
  })
  test('text is trimmed and kept', () => {
    assert.equal(normalizeNote('  contacted the host  '), 'contacted the host')
  })
})

describe('validateFiling', () => {
  test('accepts a complete filing', () => {
    const out = validateFiling({
      category: 'cleanliness',
      description: 'The apartment had not been cleaned between guests.',
      photos: ['data:image/png;base64,AA'],
    })
    assert.equal(out.category, 'cleanliness')
    assert.equal(out.photos.length, 1)
  })

  test('a missing category is refused first', () => {
    assert.throws(
      () => validateFiling({ category: '', description: 'A perfectly long and valid description here.' }),
      (e) => isDisputeInputError(e) && /choose/i.test(e.message),
    )
  })

  test('everything it throws is recognisable to a route', () => {
    // The route answers 400 with err.message verbatim, so this type is the
    // difference between the guest seeing the reason and seeing a 500.
    for (const bad of [{ category: 'x', description: 'ok' }, { category: 'other', description: 'no' }]) {
      assert.throws(() => validateFiling(bad), (e) => isDisputeInputError(e))
    }
  })

  test('an unrelated error is not mistaken for input trouble', () => {
    assert.equal(isDisputeInputError(new Error('connection reset')), false)
  })
})

describe('display', () => {
  test('a reference is short, stable and derived from the id', () => {
    const id = '1ad9ed7e-0000-4000-8000-000000000000'
    assert.equal(disputeReference(id), 'QK-1AD9ED')
    assert.equal(disputeReference(id), disputeReference(id))
  })

  test('a missing id reads as a dash, not "QK-"', () => {
    assert.equal(disputeReference(null), '—')
    assert.equal(disputeReference(''), '—')
  })

  test('the opening event reads as filed, not as a transition from nothing', () => {
    assert.equal(eventSummary({ from_status: null, to_status: 'open' }), 'Dispute filed')
    assert.equal(eventSummary({ from_status: 'open', to_status: 'in_review' }), 'Open → In review')
  })
})
