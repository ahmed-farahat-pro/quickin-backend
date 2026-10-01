import { pool } from './pool'
import { createNotification } from './notifications'
import { sendPush } from './push'
import { guardContent } from './moderation'
import {
  COMMENT_PAGE_LIMIT,
  checkCommentBody,
  commentPermissions,
  commentsLink,
  sortForHost,
  toCommentDto,
  type CommentDto,
  type CommentRow,
} from './listing-comments-core'

// Public comments on a listing, answered by its host. The rules live in
// listing-comments-core.ts; this file is the SQL around them. See README →
// Listing comments.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

/** A rule violation the route answers with `status` and this message. */
export class CommentError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CommentError'
    this.status = status
  }
}

const SELECT_COMMENT = `
  SELECT c.id, c.listing_id, c.user_id, c.body, c.created_at, c.host_reply, c.host_replied_at,
         u.full_name, u.avatar_url
    FROM listing_comments c JOIN users u ON u.id = c.user_id`

async function listingHost(listingId: string): Promise<{ host_id: string; title: string; is_published: boolean } | null> {
  if (!isUuid(listingId)) return null
  const { rows } = await pool.query(
    `SELECT host_id, title, is_published FROM listings WHERE id = $1`,
    [listingId],
  )
  return rows[0] ?? null
}

async function oneComment(listingId: string, commentId: string): Promise<CommentRow | null> {
  if (!isUuid(commentId)) return null
  const { rows } = await pool.query(
    `${SELECT_COMMENT} WHERE c.id = $1 AND c.listing_id = $2 AND c.deleted_at IS NULL`,
    [commentId, listingId],
  )
  return rows[0] ?? null
}

/** The public list. `viewerId` is null for a signed-out reader. */
export async function getListingComments(listingId: string, viewerId: string | null): Promise<{
  comments: CommentDto[]
  is_host: boolean
  can_comment: boolean
}> {
  const listing = await listingHost(listingId)
  if (!listing) return { comments: [], is_host: false, can_comment: false }
  const { rows } = await pool.query(
    `${SELECT_COMMENT}
      WHERE c.listing_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC
      LIMIT ${COMMENT_PAGE_LIMIT}`,
    [listingId],
  )
  const perms = commentPermissions(viewerId, listing.host_id)
  return {
    comments: rows.map((r: CommentRow) => toCommentDto(r, viewerId)),
    is_host: perms.is_host,
    can_comment: perms.can_comment && listing.is_published,
  }
}

export async function createListingComment(listingId: string, userId: string, raw: unknown): Promise<CommentDto> {
  const listing = await listingHost(listingId)
  if (!listing || !listing.is_published) throw new CommentError('Listing not found', 404)
  if (listing.host_id === userId) {
    throw new CommentError('You can’t comment on your own listing — reply to a guest’s comment instead', 403)
  }
  const check = checkCommentBody(raw, 'comment')
  if (!check.ok) throw new CommentError(check.error)
  await guardContent(userId, check.body, 'comment', { type: 'listing', id: listingId })

  const { rows } = await pool.query(
    `INSERT INTO listing_comments (listing_id, user_id, body) VALUES ($1, $2, $3) RETURNING id`,
    [listingId, userId, check.body],
  )
  const row = await oneComment(listingId, rows[0].id)

  const preview = check.body.length > 80 ? `${check.body.slice(0, 77)}…` : check.body
  const n = { title: `New question on “${listing.title}”`, body: preview, link: commentsLink(listingId) }
  await createNotification(listing.host_id, { type: 'comment', ...n })
  void sendPush(listing.host_id, n).catch(() => {})

  return toCommentDto(row!, userId)
}

/** The author removes their own comment; an admin may remove any. Soft delete. */
export async function deleteListingComment(
  listingId: string,
  commentId: string,
  user: { id: string; role: string },
): Promise<void> {
  const row = await oneComment(listingId, commentId)
  if (!row) throw new CommentError('Comment not found', 404)
  if (row.user_id !== user.id && user.role !== 'admin') throw new CommentError('Not allowed', 403)
  await pool.query(`UPDATE listing_comments SET deleted_at = now() WHERE id = $1`, [commentId])
}

/** Staff moderation: remove any comment by id, whatever the listing. */
export async function adminDeleteListingComment(commentId: string): Promise<boolean> {
  if (!isUuid(commentId)) return false
  const { rowCount } = await pool.query(
    `UPDATE listing_comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [commentId],
  )
  return (rowCount ?? 0) > 0
}

/** The host answers (or re-answers) a comment. One reply per comment. */
export async function replyToListingComment(
  listingId: string,
  commentId: string,
  hostId: string,
  raw: unknown,
): Promise<CommentDto> {
  const listing = await listingHost(listingId)
  if (!listing) throw new CommentError('Listing not found', 404)
  if (listing.host_id !== hostId) throw new CommentError('Only the host can reply', 403)
  const row = await oneComment(listingId, commentId)
  if (!row) throw new CommentError('Comment not found', 404)
  const check = checkCommentBody(raw, 'reply')
  if (!check.ok) throw new CommentError(check.error)
  await guardContent(hostId, check.body, 'comment', { type: 'listing', id: listingId })

  await pool.query(
    `UPDATE listing_comments SET host_reply = $2, host_replied_at = now() WHERE id = $1`,
    [commentId, check.body],
  )
  const updated = await oneComment(listingId, commentId)

  const n = { title: 'The host answered your question', body: `On “${listing.title}”`, link: commentsLink(listingId) }
  await createNotification(row.user_id, { type: 'comment_reply', ...n })
  void sendPush(row.user_id, n).catch(() => {})

  return toCommentDto(updated!, hostId)
}

export async function deleteListingCommentReply(
  listingId: string,
  commentId: string,
  hostId: string,
): Promise<CommentDto> {
  const listing = await listingHost(listingId)
  if (!listing) throw new CommentError('Listing not found', 404)
  if (listing.host_id !== hostId) throw new CommentError('Only the host can remove a reply', 403)
  const row = await oneComment(listingId, commentId)
  if (!row) throw new CommentError('Comment not found', 404)
  await pool.query(
    `UPDATE listing_comments SET host_reply = NULL, host_replied_at = NULL WHERE id = $1`,
    [commentId],
  )
  return toCommentDto({ ...row, host_reply: null, host_replied_at: null }, hostId)
}

/** Every comment on the host's listings — the host's "Guest questions" screen. */
export async function getHostComments(hostId: string): Promise<{ comments: CommentDto[]; unanswered: number }> {
  if (!isUuid(hostId)) return { comments: [], unanswered: 0 }
  const { rows } = await pool.query(
    `SELECT c.id, c.listing_id, c.user_id, c.body, c.created_at, c.host_reply, c.host_replied_at,
            u.full_name, u.avatar_url, l.title AS listing_title,
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS listing_image
       FROM listing_comments c
       JOIN listings l ON l.id = c.listing_id
       JOIN users u ON u.id = c.user_id
      WHERE l.host_id = $1 AND c.deleted_at IS NULL
      ORDER BY (c.host_reply IS NULL) DESC, c.created_at DESC
      LIMIT ${COMMENT_PAGE_LIMIT}`,
    [hostId],
  )
  const comments = sortForHost(rows.map((r: CommentRow) => toCommentDto(r, hostId, true)))
  return { comments, unanswered: comments.filter((c) => !c.reply).length }
}
