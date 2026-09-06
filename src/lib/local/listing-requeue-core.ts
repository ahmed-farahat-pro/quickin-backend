// Whether a host's edit is worth ANNOUNCING as "back under review".
//
// Every host edit re-queues the listing (see REVIEW_TRIGGERING_FIELDS in db.ts)
// and every re-queue tells the host "Listing back under review — hidden from
// guests until approved" and tells every admin "…was edited by its host and is
// waiting for approval". Both sentences are true of a listing that WAS live. Told
// about a listing that is already sitting in the queue, unpublished and pending,
// they are noise at best: nothing changed state, nothing left the guest-facing
// site, and an operator is being pinged about a queue entry they already have.
//
// This stopped being a cosmetic point when the phones started uploading a new
// listing's photos in several requests. Ten base64'd JPEGs do not fit in one
// request body — Vercel refuses anything over ~4.5 MB with a 413 before the
// function runs — so `POST /listings` now carries the cover and
// `POST /listings/:id/images` appends the rest a batch at a time. Each of those
// appends is an "edit" of a listing created seconds ago, so a host submitting a
// 10-photo listing collected three "your listing is back under review" pushes for
// a listing that had never been anywhere, and every admin got three copies of a
// queue entry they had one of.
//
// The re-queue UPDATE itself is left alone — it is idempotent, and skipping it
// would keep a stale `review_note` on the row. Only the announcement is gated.
//
// Pure: no database, no notifications, no imports. Unit-tested by
// `test/unit/listing-requeue-core.test.mjs`.

/** As much of a listing's row as this decision needs. */
export interface ListingReviewState {
  approval_status?: string | null
  is_published?: boolean | null
}

/**
 * Is this listing ALREADY in the moderation queue — pending and not published?
 *
 * A row that is pending but still published is not "already queued": something
 * put it back in front of an admin without taking it off the site, and the host
 * and the admins should hear about the edit that did. Judged on the row as it was
 * BEFORE the edit, so it has to be read before the re-queue UPDATE runs.
 */
export function alreadyInReviewQueue(current: ListingReviewState | null | undefined): boolean {
  if (!current) return false
  const status = String(current.approval_status ?? '').trim().toLowerCase()
  return status === 'pending' && current.is_published !== true
}

/**
 * Should this edit send the "back under review" notifications?
 *
 * `requeues` is the switch REVIEW_TRIGGERING_FIELDS already answered — an edit
 * that does not re-queue never announced anything to begin with. `current` is the
 * listing as it was before the edit.
 */
export function shouldAnnounceRequeue(
  requeues: boolean,
  current: ListingReviewState | null | undefined
): boolean {
  return requeues && !alreadyInReviewQueue(current)
}
