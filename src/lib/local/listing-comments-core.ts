// Listing comments — the pure rules behind `/api/local/listings/:id/comments`.
//
// Public Q&A on a listing replaced host ⇄ guest messaging (2026-10-02): anyone can
// read, any signed-in user can ask, and the listing's host answers with one reply
// per comment. Being public is the point — the answer to "is the pool heated?"
// helps every later guest — and it is also why contentguard runs on both the
// comment and the reply (surface `comment`): a number posted here reaches everyone.
//
// No runtime imports, so test/unit/listing-comments-core.test.mjs can load it
// directly. listing-comments.ts holds the SQL and imports this, never the reverse.

/** Longest comment or reply, in characters after trimming. */
export const COMMENT_MAX = 1000

/** Most comments one listing page returns. */
export const COMMENT_PAGE_LIMIT = 200

/** Rate limit: at most this many comments per user per window. */
export const COMMENT_RATE_MAX = 10
export const COMMENT_RATE_WINDOW_MS = 10 * 60_000

export type BodyCheck = { ok: true; body: string } | { ok: false; error: string }

/** Trim and validate the text of a comment or a host reply. */
export function checkCommentBody(raw: unknown, what: 'comment' | 'reply' = 'comment'): BodyCheck {
  const body = typeof raw === 'string' ? raw.trim() : ''
  if (!body) return { ok: false, error: what === 'reply' ? 'Reply cannot be empty' : 'Comment cannot be empty' }
  if (body.length > COMMENT_MAX) {
    return { ok: false, error: `Keep it under ${COMMENT_MAX} characters` }
  }
  return { ok: true, body }
}

/**
 * The public byline: first name and last initial ("Sara A."). A comment is
 * visible to the whole internet, so the full name a guest gave for bookings is
 * more than the page needs.
 */
export function authorDisplayName(fullName: unknown): string {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'QuickIn guest'
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`
}

/** Where a comment notification points. The web route; the apps parse the id out. */
export function commentsLink(listingId: string): string {
  return `/explore/${listingId}#comments`
}

export interface CommentRow {
  id: string
  listing_id: string
  user_id: string
  full_name: string | null
  avatar_url: string | null
  body: string
  created_at: string | Date
  host_reply: string | null
  host_replied_at: string | Date | null
  listing_title?: string | null
  listing_image?: string | null
}

export interface CommentDto {
  id: string
  listing_id: string
  user_id: string
  author_name: string
  author_avatar: string | null
  body: string
  created_at: string
  mine: boolean
  reply: { body: string; created_at: string } | null
  listing_title?: string | null
  listing_image?: string | null
}

const iso = (d: string | Date | null | undefined): string =>
  d instanceof Date ? d.toISOString() : String(d ?? '')

/** A row as the API returns it. `viewerId` decides `mine`; null for a signed-out reader. */
export function toCommentDto(row: CommentRow, viewerId: string | null, withListing = false): CommentDto {
  const dto: CommentDto = {
    id: row.id,
    listing_id: row.listing_id,
    user_id: row.user_id,
    author_name: authorDisplayName(row.full_name),
    author_avatar: row.avatar_url || null,
    body: row.body,
    created_at: iso(row.created_at),
    mine: viewerId != null && viewerId === row.user_id,
    reply: row.host_reply ? { body: row.host_reply, created_at: iso(row.host_replied_at) } : null,
  }
  if (withListing) {
    dto.listing_title = row.listing_title ?? null
    dto.listing_image = row.listing_image ?? null
  }
  return dto
}

/**
 * Who may do what on one listing's comments. The host answers rather than asks:
 * a top-level comment from the host would read as an advert posing as a guest.
 */
export function commentPermissions(viewerId: string | null, hostId: string | null): {
  is_host: boolean
  can_comment: boolean
} {
  const isHost = viewerId != null && hostId != null && viewerId === hostId
  return { is_host: isHost, can_comment: viewerId != null && !isHost }
}

/** The host inbox order: unanswered first, then newest. */
export function sortForHost<T extends { reply: unknown; created_at: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ua = a.reply ? 1 : 0
    const ub = b.reply ? 1 : 0
    if (ua !== ub) return ua - ub
    return b.created_at.localeCompare(a.created_at)
  })
}
