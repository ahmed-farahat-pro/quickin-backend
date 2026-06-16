import { pool } from './pool'
import { createNotification } from './notifications'
import { sendPush } from './push'

// Reviews & star ratings. A guest may review a stay only AFTER it's done
// (booking confirmed + check-out date passed), one review per booking. Ratings
// are aggregated onto the listing (see LISTING_COLS: rating + review_count).

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

export interface Review {
  id: string
  listing_id: string
  user_id: string
  booking_id: string | null
  rating: number
  comment: string | null
  photos: string[]
  created_at: string
  reviewer_name: string | null
}

/** Keep at most 6 photo strings, each a non-empty data:/http URL under ~3MB. */
function sanitizePhotos(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .filter((p) => /^(data:image\/|https?:\/\/)/i.test(p) && p.length < 3_500_000)
    .slice(0, 6)
}

/**
 * Create (or replace) the review for a completed booking.
 * Throws a user-facing Error on any rule violation.
 */
export async function createReview(args: {
  userId: string
  bookingId: string
  rating: number
  comment?: string | null
  photos?: unknown
}): Promise<Review> {
  const { userId, bookingId } = args
  const rating = Math.round(Number(args.rating))
  const photos = sanitizePhotos(args.photos)
  if (!isUuid(userId) || !isUuid(bookingId)) throw new Error('Invalid request')
  if (!(rating >= 1 && rating <= 5)) throw new Error('Rating must be between 1 and 5 stars')

  const { rows } = await pool.query(
    `SELECT id, listing_id, user_id, status, check_out FROM bookings WHERE id = $1`,
    [bookingId]
  )
  const b = rows[0]
  if (!b) throw new Error('Reservation not found')
  if (b.user_id !== userId) throw new Error('You can only review your own stay')
  // "Stay done" = the host/admin marked it completed, OR it's a confirmed booking
  // whose check-out date has passed.
  if (b.status !== 'completed' && b.status !== 'confirmed') {
    throw new Error('You can review a stay once it has been confirmed and completed')
  }
  if (b.status === 'confirmed' && new Date(b.check_out).getTime() > Date.now()) {
    throw new Error('You can leave a review after your stay is over')
  }

  const ins = await pool.query(
    `INSERT INTO reviews (listing_id, user_id, booking_id, rating, comment, photos)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (booking_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, photos = EXCLUDED.photos, created_at = now()
     RETURNING id, listing_id, user_id, booking_id, rating, comment,
               COALESCE(photos, '{}') AS photos, created_at`,
    [b.listing_id, userId, bookingId, rating, (args.comment ?? '').toString().trim() || null, photos]
  )

  // Notify the host that their listing got a new review.
  const host = await pool.query(`SELECT host_id, title FROM listings WHERE id = $1`, [b.listing_id])
  const hostId = host.rows[0]?.host_id as string | undefined
  if (hostId) {
    const title = host.rows[0]?.title ?? 'your listing'
    await createNotification(hostId, {
      type: 'new_review',
      title: 'New review',
      body: `You received a ${rating}★ review on “${title}”.`,
      link: '/host',
    })
    await sendPush(hostId, { title: 'New review ⭐', body: `${rating}★ on “${title}”`, link: '/host' })
  }

  return { ...(ins.rows[0] as Review), reviewer_name: null }
}

/** Public reviews for a listing, newest first, with the reviewer's first name. */
export async function getListingReviews(listingId: string): Promise<Review[]> {
  if (!isUuid(listingId)) return []
  const { rows } = await pool.query(
    `SELECT r.id, r.listing_id, r.user_id, r.booking_id, r.rating, r.comment,
            COALESCE(r.photos, '{}') AS photos, r.created_at,
            u.full_name AS reviewer_name
       FROM reviews r JOIN users u ON u.id = r.user_id
      WHERE r.listing_id = $1
      ORDER BY r.created_at DESC`,
    [listingId]
  )
  return rows as Review[]
}

/** Stays the signed-in guest can review now (done + not yet reviewed) — drives the UI prompt. */
export async function getReviewableBookings(userId: string): Promise<
  { booking_id: string; listing_id: string; title: string; check_out: string }[]
> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, b.listing_id, l.title, b.check_out
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.user_id = $1
        AND (b.status = 'completed' OR (b.status = 'confirmed' AND b.check_out < now()))
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)
      ORDER BY b.check_out DESC`,
    [userId]
  )
  return rows
}

// ---- Two-way: the host's review OF the guest ---------------------------------

export interface GuestReview {
  id: string
  booking_id: string
  guest_id: string
  host_id: string
  rating: number
  comment: string | null
  created_at: string
  host_name: string | null
}

/**
 * A host reviews the guest after a completed stay (one per booking). Only the
 * listing's host may review, and only once the stay is done. Throws a
 * user-facing Error on any rule violation.
 */
export async function createGuestReview(args: {
  hostId: string
  bookingId: string
  rating: number
  comment?: string | null
}): Promise<GuestReview> {
  const { hostId, bookingId } = args
  const rating = Math.round(Number(args.rating))
  if (!isUuid(hostId) || !isUuid(bookingId)) throw new Error('Invalid request')
  if (!(rating >= 1 && rating <= 5)) throw new Error('Rating must be between 1 and 5 stars')

  const { rows } = await pool.query(
    `SELECT b.id, b.user_id AS guest_id, b.listing_id, b.status, b.check_out, l.host_id
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.id = $1`,
    [bookingId]
  )
  const b = rows[0]
  if (!b) throw new Error('Reservation not found')
  if (b.host_id !== hostId) throw new Error('Only the listing host can review this guest')
  if (b.status !== 'completed' && b.status !== 'confirmed') {
    throw new Error('You can review a guest once the stay is confirmed and completed')
  }
  if (b.status === 'confirmed' && new Date(b.check_out).getTime() > Date.now()) {
    throw new Error('You can review the guest after the stay is over')
  }

  const ins = await pool.query(
    `INSERT INTO guest_reviews (booking_id, listing_id, host_id, guest_id, rating, comment)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (booking_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = now()
     RETURNING id, booking_id, guest_id, host_id, rating, comment, created_at`,
    [bookingId, b.listing_id, hostId, b.guest_id, rating, (args.comment ?? '').toString().trim() || null]
  )

  // Tell the guest they were reviewed.
  await createNotification(b.guest_id, {
    type: 'guest_review',
    title: 'A host reviewed you',
    body: `You received a ${rating}★ review from your host.`,
    link: '/reservations',
  })
  await sendPush(b.guest_id, { title: 'New review ⭐', body: `A host gave you ${rating}★`, link: '/reservations' })

  return { ...(ins.rows[0] as GuestReview), host_name: null }
}

/** Public reviews ABOUT a guest, newest first, with the reviewing host's name. */
export async function getGuestReviews(guestId: string): Promise<GuestReview[]> {
  if (!isUuid(guestId)) return []
  const { rows } = await pool.query(
    `SELECT g.id, g.booking_id, g.guest_id, g.host_id, g.rating, g.comment, g.created_at,
            u.full_name AS host_name
       FROM guest_reviews g JOIN users u ON u.id = g.host_id
      WHERE g.guest_id = $1
      ORDER BY g.created_at DESC`,
    [guestId]
  )
  return rows as GuestReview[]
}

/** Stays a host can review the guest for now (done + not yet reviewed). */
export async function getReviewableGuests(hostId: string): Promise<
  { booking_id: string; listing_id: string; title: string; guest_name: string | null; check_out: string }[]
> {
  if (!isUuid(hostId)) return []
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, b.listing_id, l.title, u.full_name AS guest_name, b.check_out
       FROM bookings b
       JOIN listings l ON l.id = b.listing_id
       JOIN users u ON u.id = b.user_id
      WHERE l.host_id = $1
        AND (b.status = 'completed' OR (b.status = 'confirmed' AND b.check_out < now()))
        AND NOT EXISTS (SELECT 1 FROM guest_reviews g WHERE g.booking_id = b.id)
      ORDER BY b.check_out DESC`,
    [hostId]
  )
  return rows
}
