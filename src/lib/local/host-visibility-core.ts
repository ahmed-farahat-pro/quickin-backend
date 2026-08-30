// Who took a listing (or a service) off the market, and who is allowed to put it
// back — pure, and DELIBERATELY free of runtime imports so `node --test` can load
// it as-is (see the note at the top of resort-core.ts, and README → Testing).
//
// QuickIn has no listing DELETE for hosts. "Remove my listing" is a reversible
// unpublish: `is_published` goes false, every booking, review and payment record
// stays exactly where it was, and the host can put the listing back up later. The
// column already existed and both readers already honour it — search filters on
// `l.is_published = true` (db.ts getListings) and createBooking refuses an
// unpublished listing outright — so flipping the flag is a real takedown, not a
// cosmetic one.
//
// The complication is that FOUR different parties can hold a listing down at the
// same time, and each must only be able to release its own grip:
//
//   the host        — this feature.               `unpublished_by_host`
//   an operator     — a manual takedown in /ops.  (no flag: see below)
//   an account block— blocked/removed host.       `unpublished_by_admin`
//   the ID gate     — host is no longer verified. `unpublished_by_verification`
//
// The three staff-side reasons already compose that way (adminSetAccountStatus
// restores only what it hid, and only when verification isn't also holding it).
// The host's grip is the fourth, and the rule that keeps it honest is:
//
//     A HOST MAY ONLY RE-PUBLISH WHAT THE HOST THEMSELVES HID.
//
// which is why reactivating is gated on `unpublished_by_host` being true rather
// than on "is it currently unpublished". That single condition is also what makes
// the flagless operator takedown safe: adminSetListingPublished(id, false)
// deliberately writes no flag (a flag would make an account-unblock resurrect a
// listing an operator killed by hand), so a host looking at it sees
// `unpublished_by_host = false` and simply has nothing to reactivate.

/** The visibility columns every decision here reads. Snake_case because that is
 *  how the rows arrive from Postgres and how the JSON leaves the API. */
export interface VisibilityRow {
  is_published?: boolean | null
  unpublished_by_host?: boolean | null
  unpublished_by_admin?: boolean | null
  unpublished_by_verification?: boolean | null
  /** Listings only. Services have no moderation queue — pass nothing. */
  approval_status?: string | null
}

/**
 * What the host is shown for one of their own listings.
 *
 * `deactivated` outranks the moderation states on purpose: it is the state the
 * host themselves set, it is what the button on the card acts on, and it is the
 * reason the listing will STAY hidden even if the queue approves it. The
 * rejection reason is rendered off `approval_status` separately, so a listing
 * that is both deactivated and rejected still tells the host why.
 *
 * `blocked` is the catch-all for "unpublished, but not by you" — an operator
 * takedown, an account block, or the identity gate. The host cannot clear it;
 * the label exists so the card can say that instead of silently looking live.
 */
export type HostVisibility =
  | 'live'
  | 'deactivated'
  | 'under_review'
  | 'rejected'
  | 'blocked'

export function hostVisibilityState(row: VisibilityRow): HostVisibility {
  if (row.unpublished_by_host === true) return 'deactivated'
  const approval = (row.approval_status ?? 'approved').toLowerCase()
  if (approval === 'rejected') return 'rejected'
  if (approval === 'pending') return 'under_review'
  return row.is_published === true ? 'live' : 'blocked'
}

/** Why a reactivate would not put the listing back in front of guests, or null
 *  when nothing is in the way. Ordered by what the host has to do about it. */
export type ReactivateBlock = 'verification' | 'staff' | 'rejected' | 'under_review' | null

/**
 * Would clearing the host's own flag actually make this listing live again?
 *
 * Returns the FIRST reason it wouldn't. A host is still allowed to reactivate
 * against a block — clearing their flag is meaningful even when someone else is
 * also holding the listing down, because it means the listing goes live the
 * moment that other reason clears, instead of quietly staying dark. The caller
 * reports the block so the UI can say "you've reactivated it, but it stays
 * hidden until X" rather than pretending it went live.
 */
export function reactivateBlock(row: VisibilityRow): ReactivateBlock {
  if (row.unpublished_by_verification === true) return 'verification'
  if (row.unpublished_by_admin === true) return 'staff'
  const approval = (row.approval_status ?? 'approved').toLowerCase()
  if (approval === 'rejected') return 'rejected'
  if (approval === 'pending') return 'under_review'
  return null
}

/** Host-facing sentence for a `reactivateBlock`. Empty string when unblocked. */
export function reactivateBlockMessage(block: ReactivateBlock): string {
  switch (block) {
    case 'verification':
      return 'Your listing stays hidden until your identity is verified again.'
    case 'staff':
      return 'Your listing stays hidden — our team has it under review. Contact support for details.'
    case 'rejected':
      return 'Your listing stays hidden because it was not approved. Fix the points in the review note and resubmit.'
    case 'under_review':
      return 'Your listing goes live as soon as our team approves it.'
    default:
      return ''
  }
}

/**
 * Does a reactivate put `is_published` back to true right now? Only when nobody
 * else is holding the listing down AND it has cleared moderation.
 */
export function goesLiveOnReactivate(row: VisibilityRow): boolean {
  return reactivateBlock(row) === null
}

/**
 * May the host press "Deactivate" on this row? Yes whenever they have not
 * already — including on a listing that is unpublished for some OTHER reason.
 *
 * That last case is not a no-op: flagging a listing that is currently sitting in
 * the review queue is how a host says "don't put this back in front of guests
 * when you approve it", and setListingApproval honours the flag when it
 * publishes. Without it, approving would drag a listing the host had walked away
 * from straight back onto the search page.
 */
export function canDeactivate(row: VisibilityRow): boolean {
  return row.unpublished_by_host !== true
}

/** May the host press "Reactivate"? Only on what they hid themselves — see the
 *  rule in this file's header. */
export function canReactivate(row: VisibilityRow): boolean {
  return row.unpublished_by_host === true
}

/**
 * The SQL fragment that decides `is_published` when a listing is APPROVED.
 *
 * Approval is the one write that turns publication on without the host asking,
 * so it is the one write that has to consult the host's flag. Expressed as SQL
 * (rather than read-modify-write in JS) so the check happens inside the same
 * UPDATE and cannot race a host deactivating in the same second.
 *
 * `approving` is the boolean placeholder for "this decision is an approval".
 */
export function publishOnApprovalSql(approving: string): string {
  return `(${approving} AND NOT COALESCE(unpublished_by_host, false))`
}

/**
 * The SQL fragment that decides `is_published` when STAFF publish a row by hand.
 *
 * Same reasoning as publishOnApprovalSql, with the same answer: an operator
 * pressing "Show" is undoing a staff decision, and a listing the HOST has taken
 * down is not a staff decision to undo. /ops labels such a row "Hidden by host"
 * rather than offering the button at all, but the guard belongs in the write —
 * the API is reachable without the console.
 */
export const PUBLISH_RESPECTING_HOST_SQL = `(NOT COALESCE(unpublished_by_host, false))`
