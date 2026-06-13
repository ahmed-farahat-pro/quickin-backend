import { pool } from './pool'

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
  created_at: string
  reviewer_name: string | null
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
}): Promise<Review> {
  const { userId, bookingId } = args
  const rating = Math.round(Number(args.rating))
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
    `INSERT INTO reviews (listing_id, user_id, booking_id, rating, comment)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (booking_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = now()
     RETURNING id, listing_id, user_id, booking_id, rating, comment, created_at`,
    [b.listing_id, userId, bookingId, rating, (args.comment ?? '').toString().trim() || null]
  )
  return { ...(ins.rows[0] as Review), reviewer_name: null }
}

/** Public reviews for a listing, newest first, with the reviewer's first name. */
export async function getListingReviews(listingId: string): Promise<Review[]> {
  if (!isUuid(listingId)) return []
  const { rows } = await pool.query(
    `SELECT r.id, r.listing_id, r.user_id, r.booking_id, r.rating, r.comment, r.created_at,
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
