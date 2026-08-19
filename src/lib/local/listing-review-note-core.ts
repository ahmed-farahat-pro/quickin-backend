// The note an operator writes when they reject a listing — and the one rule that
// makes it worth writing: it has to survive the decision.
//
// Rejecting used to spend the note immediately. /ops prompted for a reason, the
// reason was interpolated into a notification body, and then it was gone — no
// column held it. A host who missed or cleared that one notification was left with
// a red "Rejected" badge and no way to find out what to fix, which is the whole
// point of rejecting rather than deleting. The note is now stored on the listing
// (`listings.review_note`) and read back by every host surface.
//
// The note is OPTIONAL by deliberate choice: an operator clearing an obvious-spam
// queue should not be forced to type. `normalizeListingReviewNote` therefore treats
// blank, whitespace and non-string input as "no note given", and the host surfaces
// fall back to generic guidance rather than rendering an empty box.
//
// Truncation rather than rejection: a note that runs long is a slip of the finger,
// and failing the whole moderation action over it would leave a listing sitting in
// the queue. Cap it and keep going.
//
// KEEP IN SYNC — quickin-frontend and quickin-backend each hold a copy and both write
// the same Neon rows: /ops rejects through the frontend, the mobile-facing admin API
// rejects through the backend. If they disagreed, the same rejection would read
// differently depending on which door it came through. Edit one copy and paste it over
// the other verbatim. This file has no relative imports so `node --test` can load it
// directly (see the note in id-change-core.ts). db.ts imports the core, never the
// reverse.

/** Long enough for a real explanation, short enough to render in a card. */
export const MAX_LISTING_REVIEW_NOTE_CHARS = 500

/**
 * Normalize an operator's rejection note into what the column should hold.
 * Returns `null` for anything that isn't usable text — the callers store NULL and
 * every host surface then shows its generic "needs changes" copy instead.
 */
export function normalizeListingReviewNote(input: unknown): string | null {
  if (typeof input !== 'string') return null
  // Collapse the runs of blank lines a pasted note carries; keep single breaks so
  // an operator can still write a short list of fixes.
  const cleaned = input.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!cleaned) return null
  return cleaned.length > MAX_LISTING_REVIEW_NOTE_CHARS
    ? cleaned.slice(0, MAX_LISTING_REVIEW_NOTE_CHARS).trim()
    : cleaned
}

/**
 * The notification body a host receives when a listing is rejected. Shared so the
 * web and the mobile backend word it identically — the note now also lives on the
 * listing, so this text and the badge on /host can never tell different stories.
 */
export function listingRejectionMessage(title: string | null | undefined, note: unknown): string {
  const name = (typeof title === 'string' && title.trim()) || 'Your listing'
  const reason = normalizeListingReviewNote(note)
  return reason
    ? `"${name}" wasn't approved: ${reason}`
    : `"${name}" wasn't approved this time. Please review it and resubmit.`
}
