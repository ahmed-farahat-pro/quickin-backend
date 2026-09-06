// Unit tests for src/lib/local/listing-requeue-core.ts — whether a host's edit is
// worth announcing as "back under review".
//
// Offline: no database, no notifications. Run with `npm test`. The explicit `.ts`
// extension is required — Node strips types but its ESM resolver needs it, and
// listing-requeue-core.ts has no relative imports, which is what makes it loadable
// here. See the backend README → Testing.
//
// The defect behind the module: a host who submits a listing with 10 photos gets
// three "Listing back under review — hidden from guests until approved" pushes, and
// every admin gets three "was edited by its host and is waiting for approval"
// notifications, for a listing created seconds earlier that had never been visible.
// The phones cannot send ten base64'd photos in one request (Vercel answers 413
// over ~4.5 MB, before the function runs) so they append them in batches, and each
// append counted as an edit of a live listing.
//
// The half that must not break with the fix is the real case: a host editing a
// listing that IS live takes it off the site, and that has to be announced — to
// them, so they know why it vanished, and to an operator, so it gets picked up.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { alreadyInReviewQueue, shouldAnnounceRequeue } from '../../src/lib/local/listing-requeue-core.ts'

/** A listing as `createListing` leaves it: in the queue, invisible to guests. */
const JUST_CREATED = { approval_status: 'pending', is_published: false }
/** A listing an admin approved and the host published — the state worth announcing. */
const LIVE = { approval_status: 'approved', is_published: true }

describe('alreadyInReviewQueue', () => {
  test('a freshly created listing is already in the queue', () => {
    assert.equal(alreadyInReviewQueue(JUST_CREATED), true)
  })

  test('an approved, published listing is not', () => {
    assert.equal(alreadyInReviewQueue(LIVE), false)
  })

  test('an approved listing the host has unpublished is not — it was judged already', () => {
    assert.equal(alreadyInReviewQueue({ approval_status: 'approved', is_published: false }), false)
  })

  test('a rejected listing is not: it is out of the queue until the host resubmits', () => {
    assert.equal(alreadyInReviewQueue({ approval_status: 'rejected', is_published: false }), false)
  })

  test('pending AND published is not "already queued" — something re-queued it without hiding it', () => {
    assert.equal(alreadyInReviewQueue({ approval_status: 'pending', is_published: true }), false)
  })

  test('the status is compared case- and whitespace-insensitively', () => {
    assert.equal(alreadyInReviewQueue({ approval_status: ' Pending ', is_published: false }), true)
  })

  test('a row that could not be read announces nothing away', () => {
    // Not knowing the state must not silence a real edit, so the answer is "not
    // already queued" and the announcement goes out.
    assert.equal(alreadyInReviewQueue(null), false)
    assert.equal(alreadyInReviewQueue(undefined), false)
  })

  test('a NULL approval_status is not pending', () => {
    assert.equal(alreadyInReviewQueue({ approval_status: null, is_published: null }), false)
  })
})

describe('shouldAnnounceRequeue', () => {
  test('the reported defect: appending photos to a just-created listing says nothing', () => {
    assert.equal(shouldAnnounceRequeue(true, JUST_CREATED), false)
  })

  test('the batches after it are just as quiet', () => {
    // Three appends for one 10-photo listing, and none of them is news.
    for (let batch = 0; batch < 3; batch++) {
      assert.equal(shouldAnnounceRequeue(true, JUST_CREATED), false)
    }
  })

  test('editing a LIVE listing is announced — the host has to learn why it vanished', () => {
    assert.equal(shouldAnnounceRequeue(true, LIVE), true)
  })

  test('an edit that does not re-queue announces nothing either way', () => {
    // The REVIEW_TRIGGERING_FIELDS switch answered "no" — see db.ts. Whatever the
    // row says, there is no re-queue to talk about.
    assert.equal(shouldAnnounceRequeue(false, LIVE), false)
    assert.equal(shouldAnnounceRequeue(false, JUST_CREATED), false)
  })

  test('a rejected listing the host fixes is announced, so /ops looks again', () => {
    assert.equal(shouldAnnounceRequeue(true, { approval_status: 'rejected', is_published: false }), true)
  })
})
