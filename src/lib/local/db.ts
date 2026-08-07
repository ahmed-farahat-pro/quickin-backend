import { pool } from './pool'
import { resolveResortSelection } from './resorts'
import type { PoolClient } from 'pg'
import { randomInt } from 'node:crypto'
import { createNotification } from './notifications'
import { sendNotificationEmail } from './mailer'
import { sendPush } from './push'
import { containsPhoneNumber, combinesIntoPhoneNumber, PHONE_BLOCK_MESSAGE } from './contentguard'
import { INSTAPAY_KEYS, rowsToPaymentConfig } from './payment-config-core'
import type { PaymentConfig } from './payment-config-core'

export type { PaymentConfig }

const WEB_URL = process.env.WEB_URL || 'https://quickin-frontend.vercel.app'

// Look up a user's email for transactional notifications (best-effort).
async function userEmail(id: string): Promise<string | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null
  try {
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [id])
    return rows[0]?.email ?? null
  } catch {
    return null
  }
}

// Data access via node-postgres (parameterized queries). Works locally and on
// Vercel/Neon. No Supabase, no psql CLI.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export interface ListingImage {
  /** listing_images.id — what the photo add/delete/reorder endpoints address. */
  id: string
  url: string
  order: number
}

export interface Listing {
  id: string
  title: string
  description: string | null
  location: string | null
  country: string | null
  price_per_night: number
  weekend_price: number | null
  monthly_prices: Record<string, number>
  currency: string
  bedrooms: number | null
  beds: number | null
  bathrooms: number | null
  max_guests: number | null
  property_type: string | null
  region: string | null
  /** The catalog resort this listing belongs to, or null when the host typed
   *  their own (see `resort`). Region is derived from it. */
  resort_id?: string | null
  /** Display name: the catalog resort's name, or the host's free text.
   *  Free text still shows to guests as typed while it awaits moderation. */
  resort?: string | null
  cancellation_policy: string
  approval_status: string
  weekly_discount: number
  monthly_discount: number
  host_id: string | null
  host_name: string | null
  host_verified: boolean
  is_guest_favorite: boolean
  listing_code: string | null
  lat: number | null
  lng: number | null
  rating: number
  review_count: number
  created_at: string | null
  listing_images: ListingImage[]
}

// The coarse, host-picked areas QuickIn covers. The host chooses one of these
// first; search can filter by it (chips) and it's matched by free-text too.
export const REGIONS = ['North Coast', 'Ain Sokhna', 'El Gouna', 'Cairo'] as const
export type Region = (typeof REGIONS)[number]

export type ListingSort = 'recommended' | 'price_asc' | 'price_desc' | 'newest'

export interface SearchFilters {
  /** Free text — matched across title, location, region and country. */
  q?: string
  /** Back-compat alias for q (the explore bar still sends `location`). */
  location?: string
  /** Exact region chip (one of REGIONS). */
  region?: string
  /** All published listings by a given host (for "more from this host"). */
  host?: string
  guests?: number
  checkIn?: string
  checkOut?: string
  minPrice?: number
  maxPrice?: number
  propertyType?: string
  /** Listings must have ALL of these amenities. */
  amenities?: string[]
  /** Map viewport bounds for "search this area". */
  bbox?: { minLat: number; minLng: number; maxLat: number; maxLng: number }
  sort?: ListingSort
}

export interface Booking {
  id: string
  listing_id: string
  user_id: string
  check_in: string
  check_out: string
  guests: number
  total_price: number
  status: string
  created_at: string
  title: string
  location: string | null
  region: string | null
  image: string | null
  reservation_code: string | null
  host_id: string | null
  payment_status: string
  paid_at: string | null
  /** 'instapay' once a transfer screenshot is submitted (else null / legacy value). */
  payment_method: string | null
  /** Latest payment_proofs row status: submitted | approved | rejected | disputed (null = no proof). */
  payment_proof_status: string | null
  payment_submitted_at: string | null
  payment_reject_reason: string | null
  host_notes: string | null
  amenities: string[]
  cancellation_policy: string
  cancelled_at: string | null
  refund_percent: number | null
  promo_code: string | null
  promo_discount: number | null
}

export const LISTING_COLS = `
  l.id, l.title, l.description, l.location, l.country,
  l.price_per_night::float8 AS price_per_night,
  l.weekend_price::float8 AS weekend_price,
  COALESCE(l.monthly_prices, '{}'::jsonb) AS monthly_prices,
  l.currency,
  l.bedrooms, l.beds, l.bathrooms, l.max_guests, l.property_type, l.region,
  l.resort_id, COALESCE((SELECT name FROM resorts WHERE id = l.resort_id), l.resort_name) AS resort,
  COALESCE(l.cancellation_policy, 'moderate') AS cancellation_policy,
  COALESCE(l.approval_status, 'approved') AS approval_status,
  COALESCE(l.weekly_discount, 0) AS weekly_discount,
  COALESCE(l.monthly_discount, 0) AS monthly_discount,
  l.host_id, (SELECT u.full_name FROM users u WHERE u.id = l.host_id) AS host_name,
  COALESCE((SELECT u.verification_status = 'verified' FROM users u WHERE u.id = l.host_id), false) AS host_verified,
  l.is_guest_favorite, l.listing_code, l.lat::float8 AS lat, l.lng::float8 AS lng,
  to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  COALESCE(l.amenities, '{}') AS amenities,
  COALESCE((SELECT round(avg(rv.rating)::numeric, 2) FROM reviews rv WHERE rv.listing_id = l.id), 0)::float8 AS rating,
  COALESCE((SELECT count(*) FROM reviews rv WHERE rv.listing_id = l.id), 0)::int AS review_count,
  COALESCE(
    (SELECT json_agg(json_build_object('id', li.id, 'url', li.url, 'order', li."order") ORDER BY li."order")
     FROM listing_images li WHERE li.listing_id = l.id), '[]'
  ) AS listing_images
`

export async function getListings(filters: SearchFilters = {}): Promise<Listing[]> {
  const where: string[] = ['l.is_published = true']
  const params: unknown[] = []

  // Free text: match the term across title, location, region and country, so
  // "north coast" surfaces a whole area AND a property name still finds it.
  const q = (filters.q ?? filters.location ?? '').trim()
  if (q) {
    params.push('%' + q + '%')
    const p = params.length
    where.push(
      `(l.title ILIKE $${p} OR l.location ILIKE $${p} OR l.region ILIKE $${p} OR l.country ILIKE $${p})`
    )
  }
  // Exact region chip.
  if (filters.region && filters.region.trim()) {
    params.push(filters.region.trim())
    where.push(`l.region ILIKE $${params.length}`)
  }
  // A specific host's listings.
  if (filters.host && /^[0-9a-fA-F-]{36}$/.test(filters.host)) {
    params.push(filters.host)
    where.push(`l.host_id = $${params.length}`)
  }
  if (filters.guests && Number.isFinite(filters.guests) && filters.guests > 0) {
    params.push(Math.floor(filters.guests))
    where.push(`COALESCE(l.max_guests, 0) >= $${params.length}`)
  }
  if (Number.isFinite(filters.minPrice as number) && (filters.minPrice as number) >= 0) {
    params.push(filters.minPrice)
    where.push(`l.price_per_night >= $${params.length}`)
  }
  if (Number.isFinite(filters.maxPrice as number) && (filters.maxPrice as number) > 0) {
    params.push(filters.maxPrice)
    where.push(`l.price_per_night <= $${params.length}`)
  }
  if (filters.propertyType && filters.propertyType.trim()) {
    params.push(filters.propertyType.trim())
    where.push(`l.property_type ILIKE $${params.length}`)
  }
  // Has ALL the requested amenities (text[] contains).
  if (Array.isArray(filters.amenities) && filters.amenities.length > 0) {
    params.push(filters.amenities)
    where.push(`COALESCE(l.amenities, '{}') @> $${params.length}::text[]`)
  }
  // Map viewport bounds ("search this area"): keep listings inside the box.
  if (filters.bbox) {
    const { minLat, minLng, maxLat, maxLng } = filters.bbox
    if ([minLat, minLng, maxLat, maxLng].every((n) => Number.isFinite(n))) {
      params.push(minLat); const a = params.length
      params.push(maxLat); const b = params.length
      params.push(minLng); const c = params.length
      params.push(maxLng); const d = params.length
      where.push(`l.lat BETWEEN $${a} AND $${b} AND l.lng BETWEEN $${c} AND $${d}`)
    }
  }
  if (filters.checkIn && filters.checkOut && isDate(filters.checkIn) && isDate(filters.checkOut)) {
    params.push(filters.checkOut)
    const a = params.length
    params.push(filters.checkIn)
    const b = params.length
    where.push(`NOT EXISTS (
      SELECT 1 FROM bookings bk
      WHERE bk.listing_id = l.id AND bk.status <> 'cancelled'
        AND bk.check_in < $${a} AND bk.check_out > $${b}
    ) AND NOT EXISTS (
      SELECT 1 FROM listing_blocked_dates bd
      WHERE bd.listing_id = l.id
        AND bd.start_date < $${a} AND bd.end_date > $${b}
    )`)
  }

  const ORDER: Record<string, string> = {
    price_asc: 'l.price_per_night ASC, l.created_at DESC',
    price_desc: 'l.price_per_night DESC, l.created_at DESC',
    newest: 'l.created_at DESC',
    recommended: 'l.is_guest_favorite DESC, l.created_at DESC',
  }
  const orderBy = ORDER[filters.sort ?? 'recommended'] ?? ORDER.recommended

  const { rows } = await pool.query(
    `SELECT ${LISTING_COLS} FROM listings l
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}`,
    params
  )
  return rows as Listing[]
}

/** Region facet counts for published listings — powers the search chips. Always
 *  returns the canonical REGIONS (count 0 when none) so the UI is stable. */
export async function getRegionCounts(): Promise<{ region: string; count: number }[]> {
  const { rows } = await pool.query(
    `SELECT region, count(*)::int AS count
       FROM listings
      WHERE is_published = true AND region IS NOT NULL
      GROUP BY region`
  )
  const map = new Map(rows.map((r) => [String(r.region), Number(r.count)]))
  return REGIONS.map((region) => ({ region, count: map.get(region) ?? 0 }))
}

export async function getListingById(id: string): Promise<Listing | null> {
  if (!isUuid(id)) return null
  const { rows } = await pool.query(`SELECT ${LISTING_COLS} FROM listings l WHERE l.id = $1`, [id])
  return (rows[0] as Listing) ?? null
}

// ---- Availability -----------------------------------------------------------

/** One unavailable span on a listing's calendar. `kind` says why: an active
 *  booking ('booked') or a manual host block ('blocked'). Half-open [start,end). */
export interface UnavailableRange {
  id: string
  start: string
  end: string
  kind: 'booked' | 'blocked'
  note: string | null
}

/** Every span a listing is NOT bookable: non-cancelled bookings + host blocks.
 *  Public (no guest data leaks — only dates). Used to grey out calendar days. */
export async function getListingAvailability(listingId: string): Promise<UnavailableRange[]> {
  if (!isUuid(listingId)) return []
  const { rows } = await pool.query(
    `SELECT id::text AS id,
            to_char(check_in, 'YYYY-MM-DD') AS start,
            to_char(check_out, 'YYYY-MM-DD') AS "end",
            'booked'::text AS kind, NULL::text AS note
       FROM bookings
      WHERE listing_id = $1 AND status <> 'cancelled'
     UNION ALL
     SELECT id::text AS id,
            to_char(start_date, 'YYYY-MM-DD') AS start,
            to_char(end_date, 'YYYY-MM-DD') AS "end",
            'blocked'::text AS kind, note
       FROM listing_blocked_dates
      WHERE listing_id = $1
      ORDER BY start ASC`,
    [listingId]
  )
  return rows as UnavailableRange[]
}

/** Host blocks a date range on their own listing (returns null if not the host
 *  or the listing doesn't exist). Half-open [start,end); end must be after start. */
export async function blockListingDates(
  listingId: string,
  hostUserId: string,
  start: string,
  end: string,
  note: string | null = null
): Promise<UnavailableRange | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  if (!isDate(start) || !isDate(end)) throw new Error('Invalid dates (use YYYY-MM-DD)')
  if (end <= start) throw new Error('End must be after start')
  const owns = await pool.query(`SELECT 1 FROM listings WHERE id = $1 AND host_id = $2`, [listingId, hostUserId])
  if (!owns.rowCount) return null
  const { rows } = await pool.query(
    `INSERT INTO listing_blocked_dates (listing_id, start_date, end_date, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text AS id,
               to_char(start_date, 'YYYY-MM-DD') AS start,
               to_char(end_date, 'YYYY-MM-DD') AS "end",
               'blocked'::text AS kind, note`,
    [listingId, start, end, note]
  )
  return (rows[0] as UnavailableRange) ?? null
}

/** Host removes one of their own blocks. Returns true if a row was deleted. */
export async function unblockListingDates(blockId: string, hostUserId: string): Promise<boolean> {
  if (!isUuid(blockId) || !isUuid(hostUserId)) return false
  const { rowCount } = await pool.query(
    `DELETE FROM listing_blocked_dates b
      USING listings l
      WHERE b.id = $1 AND b.listing_id = l.id AND l.host_id = $2`,
    [blockId, hostUserId]
  )
  return (rowCount ?? 0) > 0
}

// ---- Bookings ---------------------------------------------------------------

const BOOKING_COLS = `
  b.id, b.listing_id, b.user_id, b.reservation_code,
  to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
  to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
  b.guests, b.total_price::float8 AS total_price, b.status,
  COALESCE(b.payment_status, 'unpaid') AS payment_status,
  to_char(b.paid_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS paid_at,
  b.payment_method,
  -- Latest transfer-screenshot submission for this booking (metadata only — the
  -- base64 image itself is fetched on demand via getBookingProof to keep lists light).
  (SELECT pp.status FROM payment_proofs pp WHERE pp.booking_id = b.id ORDER BY pp.submitted_at DESC LIMIT 1) AS payment_proof_status,
  (SELECT to_char(pp.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS') FROM payment_proofs pp WHERE pp.booking_id = b.id ORDER BY pp.submitted_at DESC LIMIT 1) AS payment_submitted_at,
  (SELECT pp.reject_reason FROM payment_proofs pp WHERE pp.booking_id = b.id ORDER BY pp.submitted_at DESC LIMIT 1) AS payment_reject_reason,
  b.host_notes,
  COALESCE(l.cancellation_policy, 'moderate') AS cancellation_policy,
  to_char(b.cancelled_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS cancelled_at,
  b.cancelled_by, b.cancelled_by_role, b.cancellation_policy AS booked_cancellation_policy,
  b.commission_rate,
  b.refund_percent,
  b.promo_code,
  b.promo_discount::float8 AS promo_discount,
  to_char(b.created_at, 'YYYY-MM-DD') AS created_at,
  l.title, l.location, l.region, l.host_id,
  (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS image
`

export interface CreateBookingInput {
  listingId: string
  userId: string
  checkIn: string
  checkOut: string
  guests: number
}

/**
 * Issue the reservation code at a CONFIRMATION transition, and only there.
 *
 * The rule (shared by the web, iOS and Android): a booking that is still waiting
 * for approval has NO code — `reservation_code` stays NULL, so there is no QR,
 * no wallet pass and no /stay/<code> link. The code is minted the moment the
 * booking becomes confirmed, and COALESCE makes that idempotent: once a guest is
 * holding a QR, re-confirming / a gateway retry / an admin edit never changes it.
 *
 * `when` is the SQL predicate that means "this row is becoming confirmed";
 * `param` is the placeholder carrying a freshly generated candidate code.
 */
function issueCodeSql(when: string, param: string): string {
  return `reservation_code = CASE WHEN ${when} THEN COALESCE(b.reservation_code, ${param}) ELSE b.reservation_code END`
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  const { listingId, userId, checkIn, checkOut, guests } = input
  if (!isUuid(listingId) || !isUuid(userId)) throw new Error('Invalid id')
  if (!isDate(checkIn) || !isDate(checkOut)) throw new Error('Invalid dates (use YYYY-MM-DD)')
  if (checkOut <= checkIn) throw new Error('Check-out must be after check-in')
  const g = Math.max(1, Math.floor(Number(guests) || 1))

  const clash = await pool.query(
    `SELECT 1 FROM bookings
       WHERE listing_id = $1 AND status <> 'cancelled'
         AND check_in < $2 AND check_out > $3
     UNION ALL
     SELECT 1 FROM listing_blocked_dates
       WHERE listing_id = $1
         AND start_date < $2 AND end_date > $3
     LIMIT 1`,
    [listingId, checkOut, checkIn]
  )
  if (clash.rowCount && clash.rowCount > 0) throw new Error('Those dates are not available')

  // NO reservation_code here on purpose — a booking starts 'pending' (awaiting the
  // host's approval) and a pending booking must have no code / no QR. It is issued
  // at the confirmation transition (see issueCodeSql).
  const { rows } = await pool.query(
    `WITH ins AS (
       -- cancellation_policy and commission_rate are SNAPSHOTTED here on purpose:
       -- both are editable after the fact (the listing's policy by its host, the
       -- rate by an admin), and a report must reflect what was in force when the
       -- booking was taken. See migrate-analytics.mjs.
       INSERT INTO bookings (listing_id, user_id, check_in, check_out, guests, total_price, status,
                             cancellation_policy, commission_rate)
       SELECT $1, $2, $3, $4, $5,
         round(
           -- Seasonal per-night sum: weekend price (Fri/Sat) → monthly override → base.
           (SELECT COALESCE(sum(
              CASE
                WHEN extract(dow from d)::int IN (5, 6) AND l.weekend_price IS NOT NULL THEN l.weekend_price
                WHEN (l.monthly_prices ->> extract(month from d)::int::text) ~ '^[0-9.]+$'
                     THEN (l.monthly_prices ->> extract(month from d)::int::text)::numeric
                ELSE l.price_per_night
              END), 0)
            FROM generate_series($3::date, $4::date - interval '1 day', interval '1 day') AS d)
           -- Length-of-stay discount on the whole stay.
           * (1 - (CASE
               WHEN ($4::date - $3::date) >= 28 THEN COALESCE(l.monthly_discount, 0)
               WHEN ($4::date - $3::date) >= 7  THEN COALESCE(l.weekly_discount, 0)
               ELSE 0 END)::numeric / 100)
         ),
         'pending',
         COALESCE(l.cancellation_policy, 'moderate'),
         COALESCE((SELECT value::numeric FROM app_settings WHERE key = 'platform_commission_rate'), 0.1)
       FROM listings l WHERE l.id = $1
       RETURNING *
     )
     SELECT ${BOOKING_COLS} FROM ins b JOIN listings l ON l.id = b.listing_id`,
    [listingId, userId, checkIn, checkOut, g]
  )
  if (!rows[0]) throw new Error('Could not create booking (listing not found)')
  const booking = rows[0] as Booking
  // Notify the host that a guest requested their listing — in-app + push + email.
  await createNotification(booking.host_id, {
    type: 'booking_request',
    title: 'New booking request',
    body: `${booking.guests} guest(s) requested ${booking.title}`,
    link: '/host',
  })
  if (booking.host_id) {
    await sendPush(booking.host_id, {
      title: 'New booking request',
      body: `${booking.guests} guest(s) requested ${booking.title}`,
      link: '/host',
    })
    const hostEmail = await userEmail(booking.host_id)
    if (hostEmail) {
      await sendNotificationEmail(
        hostEmail,
        'New booking request — QuickIn',
        'You have a new booking request',
        [
          `${booking.guests} guest(s) requested <strong>${booking.title}</strong>.`,
          `Dates: ${booking.check_in} → ${booking.check_out}.`,
          'Open your host dashboard to confirm or decline.',
        ],
        { label: 'Open host dashboard', url: `${WEB_URL}/host` }
      )
    }
  }
  return booking
}

export async function getUserBookings(userId: string): Promise<Booking[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN listings l ON l.id = b.listing_id
     WHERE b.user_id = $1 ORDER BY b.check_in DESC`,
    [userId]
  )
  return rows as Booking[]
}

/** MOCK payment — there is no real gateway yet (Paymob comes later). Marks the
 *  booking paid for its owner, confirms it (mock = instant book + pay), records a
 *  fake reference, and returns the updated booking. Returns null if the booking
 *  isn't the user's. Always "succeeds" for a valid owner. */
export async function markBookingPaid(
  bookingId: string,
  userId: string,
  method = 'card',
  paymentRef?: string,
): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(userId)) return null
  const m = method === 'bank_transfer' ? 'bank_transfer' : method === 'mock' ? 'mock' : 'card'
  // Prefer the gateway's real transaction reference (e.g. the Paymob transaction id) so the
  // payment can be reconciled; only synthesize a QK-MOCK ref for the dev/mock path with none.
  const ref = paymentRef && String(paymentRef).trim()
    ? String(paymentRef).trim()
    : 'QK-MOCK-' + genReservationCode().replace(/^QK-/, '')
  // Idempotent on gateway retries: COALESCE keeps the first paid_at/ref/method. `prev` captures
  // whether it was already paid, so the host is notified exactly once even if Paymob re-posts.
  const { rows } = await pool.query(
    `WITH prev AS (
       SELECT paid_at AS prev_paid_at FROM bookings WHERE id = $1 AND user_id = $2
     ), upd AS (
       UPDATE bookings b SET
         payment_status = 'paid',
         paid_at = COALESCE(b.paid_at, now()),
         payment_method = COALESCE(b.payment_method, $4),
         payment_ref = COALESCE(b.payment_ref, $3),
         status = CASE WHEN b.status = 'pending' THEN 'confirmed' ELSE b.status END,
         -- Paying confirms the booking, so this is a confirmation transition: mint the
         -- code here too (also backfills a legacy confirmed booking that has none).
         ${issueCodeSql(`b.status IN ('pending', 'confirmed')`, '$5')}
       WHERE b.id = $1 AND b.user_id = $2
       RETURNING *
     )
     SELECT ${BOOKING_COLS}, prev.prev_paid_at FROM upd b JOIN listings l ON l.id = b.listing_id, prev`,
    [bookingId, userId, ref, m, genReservationCode()]
  )
  const row = rows[0] as (Booking & { prev_paid_at: string | null }) | undefined
  if (!row) return null
  const booking = row as Booking
  const newlyPaid = !row.prev_paid_at
  if (newlyPaid && booking.host_id) {
    await createNotification(booking.host_id, {
      type: 'booking_paid',
      title: 'Booking paid',
      body: `${booking.title} is booked & paid · ${booking.check_in} → ${booking.check_out}`,
      link: '/host',
    })
    await sendPush(booking.host_id, {
      title: 'Booking paid 🎉',
      body: `${booking.title} — ${booking.reservation_code ?? ''}`,
      link: '/host',
    })
  }
  return booking
}

/** Record a NON-success Paymob outcome from the (HMAC-verified, trusted) webhook. Never grants
 *  payment, and never touches payment_ref — that column is reserved for the SUCCESSFUL txn id, so
 *  a later success isn't masked by an earlier failure. 'failed'/'pending' only apply while still
 *  unpaid (a late failure must not un-pay a confirmed booking); 'refunded'/'voided' reverse a prior
 *  payment (clear paid_at). id-scoped only (server-to-server). Returns true if a row was updated.
 *  The transaction id is captured in the webhook logs for audit. */
export async function setBookingPaymentOutcome(
  bookingId: string,
  outcome: 'failed' | 'pending' | 'refunded' | 'voided',
): Promise<boolean> {
  if (!isUuid(bookingId)) return false
  if (outcome === 'refunded' || outcome === 'voided') {
    const { rowCount } = await pool.query(
      // paid_at is cleared here, which is exactly why refunded_at exists: without it
      // a refunded booking has NO date at all and drops out of every money report.
      // analytics-core's MONEY_AT_SQL falls back through it. Never reintroduce a
      // `paid_at IS NOT NULL` revenue predicate — use PAID_SQL / REFUNDED_SQL.
      `UPDATE bookings SET payment_status = $2, paid_at = NULL, refunded_at = COALESCE(refunded_at, now())
        WHERE id = $1`,
      [bookingId, outcome]
    )
    return (rowCount ?? 0) > 0
  }
  const { rowCount } = await pool.query(
    `UPDATE bookings SET payment_status = $2 WHERE id = $1 AND paid_at IS NULL`,
    [bookingId, outcome]
  )
  return (rowCount ?? 0) > 0
}

/** Records the promo code + discount applied to a booking (set at pay time). */
export async function setBookingPromo(
  bookingId: string,
  userId: string,
  code: string,
  discount: number
): Promise<void> {
  if (!isUuid(bookingId) || !isUuid(userId)) return
  await pool.query(
    `UPDATE bookings SET promo_code = $3, promo_discount = $4 WHERE id = $1 AND user_id = $2`,
    [bookingId, userId, code.toUpperCase().slice(0, 40), Math.max(0, Math.round(discount))]
  )
}

/** Host attaches free-text notes to a stay (directions, gate code, city tips…)
 *  shown on the QR-linked pass page. Only the listing's host may set them. */
export async function setBookingNotes(bookingId: string, hostUserId: string, notes: string): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(hostUserId)) return null
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET host_notes = $3
       FROM listings l
       WHERE b.id = $1 AND b.listing_id = l.id AND l.host_id = $2
       RETURNING b.*
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, hostUserId, (notes ?? '').slice(0, 2000)]
  )
  return (rows[0] as Booking) ?? null
}

// ---- Cancellation policy ----------------------------------------------------

export type CancellationPolicy = 'flexible' | 'moderate' | 'strict'
export const CANCELLATION_POLICIES: CancellationPolicy[] = ['flexible', 'moderate', 'strict']

/** Coerce arbitrary input to a valid policy (defaults to 'moderate'). */
export function normalizePolicy(p?: string | null): CancellationPolicy {
  const v = String(p ?? '').toLowerCase().trim()
  return (CANCELLATION_POLICIES as string[]).includes(v) ? (v as CancellationPolicy) : 'moderate'
}

export interface CancellationQuote {
  policy: CancellationPolicy
  daysUntilCheckIn: number
  refundPercent: number
  refundAmount: number
  total: number
  currency: string
}

/** Refund % a guest gets for cancelling `daysUntilCheckIn` before check-in,
 *  given the listing's policy. Mock semantics (no real gateway yet):
 *   flexible — 100% if ≥1 day out, else 0%.
 *   moderate — 100% if ≥5 days out, else 50%.
 *   strict   — 50% if ≥7 days out, else 0%. */
export function refundPercentFor(policy: CancellationPolicy, daysUntilCheckIn: number): number {
  switch (policy) {
    case 'flexible':
      return daysUntilCheckIn >= 1 ? 100 : 0
    case 'strict':
      return daysUntilCheckIn >= 7 ? 50 : 0
    case 'moderate':
    default:
      return daysUntilCheckIn >= 5 ? 100 : 50
  }
}

function daysUntil(dateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr + 'T00:00:00')
  return Math.floor((target.getTime() - today.getTime()) / 86_400_000)
}

/** What the guest would get back if they cancelled now (no mutation). */
export async function getCancellationQuote(bookingId: string, userId: string): Promise<CancellationQuote | null> {
  if (!isUuid(bookingId) || !isUuid(userId)) return null
  const { rows } = await pool.query(
    `SELECT b.user_id, b.total_price::float8 AS total, b.status,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            COALESCE(l.cancellation_policy, 'moderate') AS policy, l.currency
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.id = $1`,
    [bookingId]
  )
  const b = rows[0]
  if (!b || b.user_id !== userId) return null
  const policy = normalizePolicy(b.policy)
  const days = daysUntil(b.check_in)
  const refundPercent = refundPercentFor(policy, days)
  const total = Number(b.total) || 0
  return {
    policy,
    daysUntilCheckIn: days,
    refundPercent,
    refundAmount: Math.round((total * refundPercent) / 100),
    total,
    currency: b.currency ?? 'EGP',
  }
}

/** A guest cancels their own (pending/confirmed) booking. Records the mock
 *  refund per the listing's policy, sets status='cancelled', notifies the host.
 *  Returns the updated booking + the quote, or null if it isn't the guest's /
 *  can't be cancelled. */
export async function cancelBooking(
  bookingId: string,
  userId: string
): Promise<{ booking: Booking; quote: CancellationQuote } | null> {
  const quote = await getCancellationQuote(bookingId, userId)
  if (!quote) return null
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET
         status = 'cancelled',
         cancelled_at = now(),
         refund_percent = $3,
         refund_amount = $4,
         -- B3: record the actor in the SAME statement as the status change, so it
         -- can never be skipped. $2 is the guest's own id (also the WHERE guard).
         cancelled_by = $2::text,
         cancelled_by_role = 'guest'
       WHERE b.id = $1 AND b.user_id = $2 AND b.status IN ('pending', 'confirmed')
       RETURNING *
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, userId, quote.refundPercent, quote.refundAmount]
  )
  const booking = rows[0] as Booking | undefined
  if (!booking) return null
  if (booking.host_id) {
    await createNotification(booking.host_id, {
      type: 'booking_cancelled',
      title: 'Reservation cancelled',
      body: `${booking.title} — ${booking.check_in} → ${booking.check_out} was cancelled by the guest.`,
      link: '/host',
    })
    await sendPush(booking.host_id, {
      title: 'Reservation cancelled',
      body: `${booking.title} (${booking.reservation_code ?? ''})`,
      link: '/host',
    })
  }
  return { booking, quote }
}

// The three single-purpose host edits below predate the full edit form. They now
// delegate to updateListingDetails so there is exactly ONE code path that writes a
// listing — and therefore no way to change a listing without the re-review rule in
// REVIEW_TRIGGERING_FIELDS applying. Signatures and return values are unchanged.

/** Host updates the cancellation policy on their own listing. Returns the
 *  refreshed listing, or null if the caller isn't the host. */
export async function updateListingPolicy(
  listingId: string,
  hostUserId: string,
  policy: string
): Promise<Listing | null> {
  return updateListingDetails(listingId, hostUserId, { cancellation_policy: policy })
}

/** Host updates the length-of-stay discounts (% off) on their own listing. */
export async function updateListingDiscounts(
  listingId: string,
  hostUserId: string,
  weekly: number,
  monthly: number
): Promise<Listing | null> {
  return updateListingDetails(listingId, hostUserId, {
    weekly_discount: weekly,
    monthly_discount: monthly,
  })
}

/** Host sets seasonal pricing: weekend nightly price + per-month overrides. */
export async function updateListingPricing(
  listingId: string,
  hostUserId: string,
  weekendPrice: unknown,
  monthlyPrices: unknown
): Promise<Listing | null> {
  return updateListingDetails(listingId, hostUserId, {
    weekend_price: weekendPrice ?? null,
    monthly_prices: monthlyPrices ?? {},
  })
}

export interface StayQuote {
  nights: number
  subtotal: number
  discountPercent: number
  total: number
  nightlyAvg: number
  currency: string
  hasSeasonalPricing: boolean
}

/** Authoritative price for a date range — honors weekend + monthly pricing and
 *  the length-of-stay discount (same maths the booking uses). Lets clients show
 *  the exact total for the chosen dates without duplicating the logic. */
export async function getStayQuote(listingId: string, checkIn: string, checkOut: string): Promise<StayQuote | null> {
  if (!isUuid(listingId) || !isDate(checkIn) || !isDate(checkOut) || checkOut <= checkIn) return null
  const { rows } = await pool.query(
    `SELECT
       ($2::date - $1::date) AS nights,
       (SELECT COALESCE(sum(
          CASE
            WHEN extract(dow from d)::int IN (5, 6) AND l.weekend_price IS NOT NULL THEN l.weekend_price
            WHEN (l.monthly_prices ->> extract(month from d)::int::text) ~ '^[0-9.]+$'
                 THEN (l.monthly_prices ->> extract(month from d)::int::text)::numeric
            ELSE l.price_per_night
          END), 0)
        FROM generate_series($1::date, $2::date - interval '1 day', interval '1 day') d)::float8 AS subtotal,
       (CASE WHEN ($2::date - $1::date) >= 28 THEN COALESCE(l.monthly_discount, 0)
             WHEN ($2::date - $1::date) >= 7  THEN COALESCE(l.weekly_discount, 0)
             ELSE 0 END)::int AS discount_percent,
       (l.weekend_price IS NOT NULL OR l.monthly_prices <> '{}'::jsonb) AS has_seasonal,
       l.currency
     FROM listings l WHERE l.id = $3`,
    [checkIn, checkOut, listingId]
  )
  const r = rows[0]
  if (!r) return null
  const nights = Number(r.nights)
  const subtotal = Math.round(Number(r.subtotal))
  const discountPercent = Number(r.discount_percent)
  const total = Math.round(subtotal * (1 - discountPercent / 100))
  return {
    nights,
    subtotal,
    discountPercent,
    total,
    nightlyAvg: nights > 0 ? Math.round(subtotal / nights) : subtotal,
    currency: r.currency ?? 'EGP',
    hasSeasonalPricing: Boolean(r.has_seasonal),
  }
}

// ---- Listing approval queue (S7) -------------------------------------------

/** Listings awaiting moderation, with the host's name/email + the ownership doc
 *  (admin only — the doc is never exposed publicly). */
export async function listPendingListings(): Promise<
  (Listing & { host_email: string | null; has_ownership_doc: boolean })[]
> {
  // The ownership document itself is NOT returned. It used to ride inline, as base64,
  // on every pending listing, for anyone holding the `listings` module and with no
  // record of who saw it. The web project now serves one document at a time from
  // /api/local/admin/documents/ownership/:id, behind the `documents` module, and
  // audits every open. No mobile client ever read this field.
  const { rows } = await pool.query(
    `SELECT ${LISTING_COLS},
            (SELECT u.email FROM users u WHERE u.id = l.host_id) AS host_email,
            (l.ownership_doc IS NOT NULL AND l.ownership_doc <> '') AS has_ownership_doc
       FROM listings l
      WHERE COALESCE(l.approval_status, 'approved') = 'pending'
      ORDER BY l.created_at DESC`
  )
  return rows as (Listing & { host_email: string | null; has_ownership_doc: boolean })[]
}

/** Admin approves (publish + 'approved') or rejects (unpublish + 'rejected') a
 *  listing; notifies the host. Returns the refreshed listing. */
export async function setListingApproval(listingId: string, approve: boolean): Promise<Listing | null> {
  if (!isUuid(listingId)) return null
  const status = approve ? 'approved' : 'rejected'
  const { rows } = await pool.query(
    `UPDATE listings SET approval_status = $2, is_published = $3 WHERE id = $1
     RETURNING id, host_id, title`,
    [listingId, status, approve]
  )
  const r = rows[0]
  if (!r) return null
  if (r.host_id) {
    await createNotification(r.host_id, {
      type: approve ? 'listing_approved' : 'listing_rejected',
      title: approve ? 'Your listing is live 🎉' : 'Listing needs changes',
      body: approve
        ? `“${r.title}” has been approved and is now visible to guests.`
        : `“${r.title}” wasn’t approved. Please review the details and resubmit.`,
      link: '/host',
    })
    await sendPush(r.host_id, {
      title: approve ? 'Listing approved 🎉' : 'Listing not approved',
      body: r.title,
      link: '/host',
    })
  }
  return getListingById(listingId)
}

/** Host uploads/replaces their ownership doc → re-queues the listing to
 *  'pending' (and unpublishes) for re-review. Host-only. */
export async function setListingOwnershipDoc(
  listingId: string,
  hostUserId: string,
  doc: string
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  const d = assertImageSrc(doc, 'Please attach a photo of the document')
  const { rowCount } = await pool.query(
    `UPDATE listings SET ownership_doc = $3, ${REQUEUE_SET}
      WHERE id = $1 AND host_id = $2`,
    [listingId, hostUserId, d]
  )
  if (!rowCount) return null
  const updated = await getListingById(listingId)
  if (updated) await notifyListingRequeued(updated)
  return updated
}

// ---- Full listing edit → automatic re-review (W3) ---------------------------
// A host can edit EVERY aspect of their own listing — details, pricing, photos —
// from web/iOS/Android. Two invariants hold for every helper below:
//   1. Ownership is enforced inside the SQL (`WHERE id = $1 AND host_id = $2`, or
//      a join back to listings.host_id for listing_images). A host id is never
//      taken from the request body. No row matched → null → the route answers 403.
//   2. The re-review flip lives in the SAME statement as the edit, so it can't be
//      skipped — exactly like setListingOwnershipDoc above.

/** Property types the create-listing forms offer (web icon grid, iOS
 *  AddListingView, Android HostScreen). The stored value stays English —
 *  clients translate the label only — so matching is case-insensitive. */
export const PROPERTY_TYPES = [
  'Apartment', 'House', 'Villa', 'Cabin', 'Studio', 'Loft', 'Chalet', 'Cottage',
  'Guest suite', 'Guest House',
] as const

/** Max photos on a listing — the cap createListing already enforces. */
export const MAX_LISTING_PHOTOS = 10

/** Max chars for an inline image (data: URL) — same budget as the ownership doc. */
const MAX_IMAGE_CHARS = 3_500_000

/** Every field a host may edit through PATCH /api/local/listings/:id.
 *  `images` is the photo set (listing_images rows), not a listings column. */
export const EDITABLE_LISTING_FIELDS = [
  // Moderation-relevant — what an admin actually looks at.
  'title', 'description', 'location', 'country', 'region', 'resort', 'lat', 'lng',
  'property_type', 'max_guests', 'bedrooms', 'beds', 'bathrooms', 'amenities',
  'ownership_doc', 'images',
  // Commercial — what the host tunes day to day.
  'price_per_night', 'weekend_price', 'monthly_prices',
  'weekly_discount', 'monthly_discount', 'cancellation_policy',
] as const
export type ListingEditField = (typeof EDITABLE_LISTING_FIELDS)[number]

/**
 * THE re-review switch — the ONE place that decides which host edits send a
 * listing back to the admin queue (approval_status='pending' + is_published=false).
 *
 * Product decision, as specified: EVERY edit re-reviews, including price,
 * discounts, seasonal pricing and cancellation policy — so a host nudging their
 * nightly rate takes their own listing offline until an admin approves it.
 * To move to the usual split (moderation fields re-review, commercial fields save
 * live) replace the value below with the moderation subset, e.g.
 *   export const REVIEW_TRIGGERING_FIELDS: readonly ListingEditField[] =
 *     ['title','description','location','country','region','lat','lng',
 *      'property_type','max_guests','bedrooms','beds','bathrooms','amenities',
 *      'ownership_doc','images']
 * Nothing else in the codebase needs to change.
 */
export const REVIEW_TRIGGERING_FIELDS: readonly ListingEditField[] = EDITABLE_LISTING_FIELDS

/** Does this set of edited fields put the listing back in front of an admin? */
export function requeuesForReview(fields: readonly string[]): boolean {
  return fields.some((f) => (REVIEW_TRIGGERING_FIELDS as readonly string[]).includes(f))
}

/** Photos are one field of the edit form — same switch, asked once. */
const photosRequeue = () => requeuesForReview(['images'])

/** The SET fragment every re-queueing edit appends — identical to the ownership-doc flow. */
const REQUEUE_SET = `approval_status = 'pending', is_published = false`

/** Something the host can fix in the form (→ HTTP 400), as opposed to a real
 *  failure (→ 500). A named class rather than message-sniffing, so adding a
 *  validation rule can't silently start answering 500. Mirrors the web's
 *  HostApplicationError. */
export class ListingInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ListingInputError'
  }
}

/** Was this thrown by one of the listing validators above? (`name` is checked too
 *  so it still works if the module is instantiated twice in a bundle.) */
export function isListingInputError(err: unknown): boolean {
  return err instanceof ListingInputError || (err instanceof Error && err.name === 'ListingInputError')
}

/** A photo / document source: an inline data:image or an http(s) URL, bounded in
 *  size. Mirrors setListingOwnershipDoc + assertProofImage. */
function assertImageSrc(src: unknown, message = 'Please attach a valid photo'): string {
  const v = String(src ?? '').trim()
  if (!/^(data:image\/|https?:\/\/)/i.test(v)) throw new ListingInputError(message)
  if (v.length > MAX_IMAGE_CHARS) throw new ListingInputError('That image is too large')
  return v
}

/** Non-blank text, else a per-field error (the clients highlight the input). */
function assertText(v: unknown, label: string): string {
  const s = String(v ?? '').trim()
  if (!s) throw new ListingInputError(`${label} is required`)
  return s
}

/** A whole number >= min, else a per-field error. */
function assertInt(v: unknown, label: string, min: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new ListingInputError(`${label} must be a whole number of at least ${min}`)
  }
  return n
}

/** A coordinate inside its valid range, or null to clear the pin. */
function assertCoord(v: unknown, label: string, limit: number): number | null {
  if (v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new ListingInputError(`${label} must be between -${limit} and ${limit}`)
  return n
}

/** Canonical (English) property type for any casing the clients send. */
function assertPropertyType(v: unknown): string {
  const s = String(v ?? '').trim()
  const match = PROPERTY_TYPES.find((p) => p.toLowerCase() === s.toLowerCase())
  if (!match) throw new ListingInputError(`Choose a property type: ${PROPERTY_TYPES.join(', ')}`)
  return match
}

/** Canonical region — one of REGIONS, the same chips search filters on. */
function assertRegion(v: unknown): string {
  const s = String(v ?? '').trim()
  const match = REGIONS.find((r) => r.toLowerCase() === s.toLowerCase())
  if (!match) throw new ListingInputError(`Choose an area: ${REGIONS.join(', ')}`)
  return match
}

/** An array of non-empty amenity names (trimmed, deduped). */
function assertAmenities(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ListingInputError('Amenities must be a list')
  const out: string[] = []
  for (const a of v) {
    if (typeof a !== 'string') throw new ListingInputError('Amenities must be a list of names')
    const s = a.trim().slice(0, 64)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** The full replacement photo set for a listing (array order = display order, so
 *  the first entry is the cover). Validated like every other image we accept. */
function assertPhotoSet(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ListingInputError('Photos must be a list')
  if (v.length > MAX_LISTING_PHOTOS) throw new ListingInputError(`A listing can have at most ${MAX_LISTING_PHOTOS} photos`)
  return v.map((u) => assertImageSrc(u, 'Each photo must be an image'))
}

/** Partial edit — ONLY the keys actually present are written; omitted keys keep
 *  their current value (never nulled out). Values are `unknown` by design: the
 *  route hands the raw JSON straight through and validation happens here, once. */
export interface ListingPatch {
  title?: unknown
  description?: unknown
  location?: unknown
  country?: unknown
  region?: unknown
  resort_id?: unknown
  resort_name?: unknown
  lat?: unknown
  lng?: unknown
  property_type?: unknown
  max_guests?: unknown
  bedrooms?: unknown
  beds?: unknown
  bathrooms?: unknown
  amenities?: unknown
  ownership_doc?: unknown
  /** Full replacement photo set (first = cover). Omit to leave photos untouched. */
  images?: unknown
  price_per_night?: unknown
  weekend_price?: unknown
  monthly_prices?: unknown
  weekly_discount?: unknown
  monthly_discount?: unknown
  cancellation_policy?: unknown
}

/**
 * Host edits their own listing. Ownership is enforced in the SQL, so a listing
 * that isn't theirs matches no row and returns null (the route maps that to 403).
 * Every re-review-triggering field (today: all of them — see
 * REVIEW_TRIGGERING_FIELDS) puts the listing back to 'pending' + unpublished in
 * the SAME statement as the edit. Returns the refreshed listing.
 */
export async function updateListingDetails(
  listingId: string,
  hostUserId: string,
  patch: ListingPatch
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null

  const sets: string[] = []
  const vals: unknown[] = [listingId, hostUserId]
  const touched: ListingEditField[] = []
  // Column name === patch key for every scalar field, so one helper covers them all.
  const put = (field: Exclude<ListingEditField, 'images'>, val: unknown, cast = '') => {
    vals.push(val)
    sets.push(`${field} = $${vals.length}${cast}`)
    touched.push(field)
  }

  // --- Moderation-relevant fields ---
  if (patch.title !== undefined) put('title', assertText(patch.title, 'Title').slice(0, 200))
  if (patch.description !== undefined) put('description', assertText(patch.description, 'Description').slice(0, 5000))
  if (patch.location !== undefined) put('location', assertText(patch.location, 'Location').slice(0, 200))
  if (patch.country !== undefined) put('country', String(patch.country ?? '').trim().slice(0, 100) || null)
  // Resort is THREE columns (resort_id, resort_name, region) driven by one logical
  // edit, so it cannot go through put(), which maps one field to one column. When a
  // resort is chosen its region wins, so the standalone region edit is skipped.
  const resortEdited = patch.resort_id !== undefined || patch.resort_name !== undefined
  if (patch.region !== undefined && !resortEdited) put('region', assertRegion(patch.region))
  if (resortEdited) {
    const sel = await resolveResortSelection({
      resortId: patch.resort_id === undefined ? null : String(patch.resort_id ?? '') || null,
      resortName: patch.resort_name === undefined ? null : (patch.resort_name as string | null),
      region: patch.region === undefined ? null : assertRegion(patch.region),
      userId: hostUserId,
    })
    vals.push(sel.resort_id); sets.push(`resort_id = $${vals.length}::uuid`)
    vals.push(sel.resort_name); sets.push(`resort_name = $${vals.length}`)
    vals.push(sel.region); sets.push(`region = $${vals.length}`)
    touched.push('resort')
  }
  if (patch.lat !== undefined) put('lat', assertCoord(patch.lat, 'Latitude', 90))
  if (patch.lng !== undefined) put('lng', assertCoord(patch.lng, 'Longitude', 180))
  if (patch.property_type !== undefined) put('property_type', assertPropertyType(patch.property_type))
  // max_guests keeps createListing's floor of 1 — a 0-guest listing can't be booked.
  if (patch.max_guests !== undefined) put('max_guests', assertInt(patch.max_guests, 'Guests', 1))
  if (patch.bedrooms !== undefined) put('bedrooms', assertInt(patch.bedrooms, 'Bedrooms', 0))
  if (patch.beds !== undefined) put('beds', assertInt(patch.beds, 'Beds', 0))
  if (patch.bathrooms !== undefined) put('bathrooms', assertInt(patch.bathrooms, 'Bathrooms', 0))
  if (patch.amenities !== undefined) put('amenities', assertAmenities(patch.amenities))
  if (patch.ownership_doc !== undefined) {
    put('ownership_doc', assertImageSrc(patch.ownership_doc, 'Please attach a photo of the document'))
  }

  // --- Commercial fields (same re-review rule today) ---
  if (patch.price_per_night !== undefined) {
    const price = Number(patch.price_per_night)
    if (!Number.isFinite(price) || price <= 0) throw new ListingInputError('Price must be greater than 0')
    put('price_per_night', Math.round(price))
  }
  if (patch.weekend_price !== undefined) put('weekend_price', cleanPrice(patch.weekend_price))
  if (patch.monthly_prices !== undefined) put('monthly_prices', cleanMonthlyPrices(patch.monthly_prices), '::jsonb')
  if (patch.weekly_discount !== undefined) put('weekly_discount', clampDiscount(patch.weekly_discount))
  if (patch.monthly_discount !== undefined) put('monthly_discount', clampDiscount(patch.monthly_discount))
  if (patch.cancellation_policy !== undefined) put('cancellation_policy', normalizePolicy(String(patch.cancellation_policy)))

  // --- Photos (listing_images rows, replaced wholesale when supplied) ---
  // null = not sent (leave photos alone); [] = sent empty (clear them).
  const nextPhotos = patch.images === undefined ? null : assertPhotoSet(patch.images)
  if (nextPhotos !== null) touched.push('images')

  if (!touched.length) throw new ListingInputError('No listing fields to update')
  const requeue = requeuesForReview(touched)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (sets.length || requeue) {
      // Ownership + the re-review flip in ONE statement — nothing can bypass it.
      const { rowCount } = await client.query(
        `UPDATE listings SET ${[...sets, ...(requeue ? [REQUEUE_SET] : [])].join(', ')}
          WHERE id = $1 AND host_id = $2`,
        vals
      )
      if (!rowCount) {
        await client.query('ROLLBACK')
        return null
      }
    } else if (!(await ownsListing(client, listingId, hostUserId))) {
      await client.query('ROLLBACK')
      return null
    }
    if (nextPhotos !== null) await replaceListingImages(client, listingId, nextPhotos)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const updated = await getListingById(listingId)
  if (updated && requeue) await notifyListingRequeued(updated)
  return updated
}

// ---- Photos (listing_images) ------------------------------------------------
// Add / delete / reorder, each ownership-checked through listings.host_id and each
// re-queuing the listing — a photo change is exactly what a moderator looks at.

/** Does this host own this listing? (Row locked for the rest of the transaction.) */
async function ownsListing(client: PoolClient, listingId: string, hostUserId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM listings WHERE id = $1 AND host_id = $2 FOR UPDATE`,
    [listingId, hostUserId]
  )
  return (rowCount ?? 0) > 0
}

/** Re-queue for admin review inside an open transaction. Ownership re-checked. */
async function requeueListing(client: PoolClient, listingId: string, hostUserId: string): Promise<void> {
  await client.query(`UPDATE listings SET ${REQUEUE_SET} WHERE id = $1 AND host_id = $2`, [listingId, hostUserId])
}

/** Swap a listing's whole photo set — array order becomes display order (first = cover). */
async function replaceListingImages(client: PoolClient, listingId: string, urls: string[]): Promise<void> {
  await client.query(`DELETE FROM listing_images WHERE listing_id = $1`, [listingId])
  for (let i = 0; i < urls.length; i++) {
    await client.query(`INSERT INTO listing_images (listing_id, url, "order") VALUES ($1,$2,$3)`, [listingId, urls[i], i])
  }
}

/** Host appends photos to their own listing (kept under MAX_LISTING_PHOTOS) →
 *  re-queues for review. Returns the refreshed listing, or null if not theirs. */
export async function addListingImages(
  listingId: string,
  hostUserId: string,
  urls: unknown
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  const list = Array.isArray(urls) ? urls : [urls]
  if (!list.length) throw new ListingInputError('Please attach at least one photo')
  const photos = list.map((u) => assertImageSrc(u, 'Each photo must be an image'))

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await ownsListing(client, listingId, hostUserId))) {
      await client.query('ROLLBACK')
      return null
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS count, COALESCE(max("order"), -1)::int AS max_order
         FROM listing_images WHERE listing_id = $1`,
      [listingId]
    )
    const { count, max_order } = rows[0] as { count: number; max_order: number }
    if (count + photos.length > MAX_LISTING_PHOTOS) {
      throw new ListingInputError(`A listing can have at most ${MAX_LISTING_PHOTOS} photos`)
    }
    for (let i = 0; i < photos.length; i++) {
      await client.query(
        `INSERT INTO listing_images (listing_id, url, "order") VALUES ($1,$2,$3)`,
        [listingId, photos[i], max_order + 1 + i]
      )
    }
    if (photosRequeue()) await requeueListing(client, listingId, hostUserId)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const updated = await getListingById(listingId)
  if (updated && photosRequeue()) await notifyListingRequeued(updated)
  return updated
}

/** Host removes one photo from their own listing (the remaining orders are
 *  re-packed to 0..n-1, so the next photo becomes the cover) → re-queues for review. */
export async function deleteListingImage(
  listingId: string,
  hostUserId: string,
  imageId: string
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId) || !isUuid(imageId)) return null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Ownership via a join back to listings.host_id — the image id alone proves nothing.
    const { rowCount } = await client.query(
      `DELETE FROM listing_images li
        USING listings l
        WHERE li.id = $3 AND li.listing_id = $1 AND l.id = li.listing_id AND l.host_id = $2`,
      [listingId, hostUserId, imageId]
    )
    if (!rowCount) {
      await client.query('ROLLBACK')
      return null
    }
    await client.query(
      `UPDATE listing_images li SET "order" = ranked.rn - 1
         FROM (SELECT id, row_number() OVER (ORDER BY "order", id) AS rn
                 FROM listing_images WHERE listing_id = $1) ranked
        WHERE li.id = ranked.id AND li."order" <> ranked.rn - 1`,
      [listingId]
    )
    if (photosRequeue()) await requeueListing(client, listingId, hostUserId)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const updated = await getListingById(listingId)
  if (updated && photosRequeue()) await notifyListingRequeued(updated)
  return updated
}

/** Host reorders their own listing's photos — `orderedImageIds` must list every
 *  photo of the listing exactly once; index 0 becomes the cover. Re-queues for review. */
export async function reorderListingImages(
  listingId: string,
  hostUserId: string,
  orderedImageIds: unknown
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  if (!Array.isArray(orderedImageIds)) throw new ListingInputError('Photo order must be a list of photo ids')
  const ids = orderedImageIds.map((v) => String(v ?? '').trim())
  if (!ids.length || ids.some((v) => !isUuid(v))) throw new ListingInputError('Photo order must be a list of photo ids')
  if (new Set(ids).size !== ids.length) throw new ListingInputError('Each photo can appear only once in the order')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await ownsListing(client, listingId, hostUserId))) {
      await client.query('ROLLBACK')
      return null
    }
    const { rows } = await client.query(`SELECT id FROM listing_images WHERE listing_id = $1`, [listingId])
    const current = new Set((rows as { id: string }[]).map((r) => r.id))
    if (current.size !== ids.length || ids.some((id) => !current.has(id))) {
      throw new ListingInputError('The photo order must list every photo of this listing exactly once')
    }
    for (let i = 0; i < ids.length; i++) {
      await client.query(`UPDATE listing_images SET "order" = $3 WHERE id = $2 AND listing_id = $1`, [listingId, ids[i], i])
    }
    if (photosRequeue()) await requeueListing(client, listingId, hostUserId)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const updated = await getListingById(listingId)
  if (updated && photosRequeue()) await notifyListingRequeued(updated)
  return updated
}

/** A host edit put this listing back in the moderation queue: tell the host it's
 *  hidden until approved (the same shape as createListing's "submitted for review")
 *  and ping every admin so the /ops queue is picked up. Best-effort — a
 *  notification failure never fails the edit. */
async function notifyListingRequeued(listing: Listing): Promise<void> {
  try {
    if (listing.host_id) {
      await createNotification(listing.host_id, {
        type: 'listing_submitted',
        title: 'Listing back under review',
        body: `“${listing.title}” was updated, so it’s under review again. It stays hidden from guests until an admin approves it.`,
        link: '/host',
      })
      await sendPush(listing.host_id, {
        title: 'Listing back under review',
        body: `${listing.title} — hidden from guests until approved`,
        link: '/host',
      })
    }
    const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'admin'`)
    for (const admin of rows as { id: string }[]) {
      await createNotification(admin.id, {
        type: 'listing_pending',
        title: 'Listing edited — needs review',
        body: `“${listing.title}” was edited by its host and is waiting for approval.`,
        link: '/ops',
      })
    }
  } catch (e) {
    console.error('notifyListingRequeued failed (ignored):', e)
  }
}

// ---- Stay guide (host-authored content on a confirmed booking) ---------------
// The host enriches a confirmed reservation with info blocks, photos, QR links to
// places and attachments; the guest sees them on the stay pass the QR opens.
// bookings.host_notes (free text) still works exactly as before — these are
// structured items alongside it.

export const STAY_GUIDE_KINDS = ['info', 'photo', 'place_qr', 'attachment'] as const
export type StayGuideKind = (typeof STAY_GUIDE_KINDS)[number]

export interface StayGuideItem {
  id: string
  kind: StayGuideKind
  title: string | null
  body: string | null
  url: string | null
  order: number
}

/** Display fields only — never the booking id or anything about the guest. The
 *  public stay page returns exactly this shape too. */
const GUIDE_COLS = `g.id::text AS id, g.kind, g.title, g.body, g.url, g."order"`
const GUIDE_ORDER = `ORDER BY g."order", g.created_at`

const MAX_GUIDE_ASSET = 3_500_000 // same cap as ownership docs / payment proofs
const MAX_GUIDE_TITLE = 120
const MAX_GUIDE_BODY = 4000
const MAX_GUIDE_LINK = 2000

/** One of the four item types, else a guest-readable error. */
function assertGuideKind(kind: unknown): StayGuideKind {
  const k = String(kind ?? '').trim().toLowerCase()
  if (!(STAY_GUIDE_KINDS as readonly string[]).includes(k)) {
    throw new Error('Choose a type: info, photo, place_qr or attachment')
  }
  return k as StayGuideKind
}

/** Host-typed text, capped and stored as PLAIN TEXT — it is rendered to strangers
 *  on the public pass, so every client escapes it (never dangerouslySetInnerHTML). */
function cleanGuideText(v: unknown, max: number): string | null {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, max) : null
}

/** Validate the item's URL for its kind (mirrors setListingOwnershipDoc):
 *   photo/attachment — an inline data: URL or an http(s) link, max ~3.5MB;
 *   place_qr        — a link the guest's phone will OPEN, so http(s) ONLY
 *                     (data: and javascript: are rejected);
 *   info            — carries no URL. */
function cleanGuideUrl(kind: StayGuideKind, url: unknown): string | null {
  const u = String(url ?? '').trim()
  if (kind === 'info') return null
  if (kind === 'place_qr') {
    if (!/^https?:\/\//i.test(u)) throw new Error('Please use a link starting with http:// or https://')
    if (u.length > MAX_GUIDE_LINK) throw new Error('That link is too long')
    return u
  }
  if (!/^(data:|https?:\/\/)/i.test(u)) {
    throw new Error(kind === 'photo' ? 'Please attach a photo' : 'Please attach a file')
  }
  if (u.length > MAX_GUIDE_ASSET) throw new Error('That file is too large (max ~3.5MB)')
  return u
}

/** Clamp the manual sort position. */
function clampGuideOrder(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.max(0, Math.min(9999, n)) : null
}

export interface StayGuideInput {
  kind: unknown
  title?: unknown
  body?: unknown
  url?: unknown
  order?: unknown
}

/** The booking's guide items. Read side only — callers authorize first. */
async function getStayGuideItems(bookingId: string): Promise<StayGuideItem[]> {
  const { rows } = await pool.query(
    `SELECT ${GUIDE_COLS} FROM stay_guide_items g WHERE g.booking_id = $1 ${GUIDE_ORDER}`,
    [bookingId]
  )
  return rows as StayGuideItem[]
}

/** The guide for a reservation, for the booking's guest, the listing's host, or
 *  an admin — else null (same authorization shape as getBookingProof). */
export async function listStayGuide(
  bookingId: string,
  requester: { id: string; role: string },
): Promise<StayGuideItem[] | null> {
  if (!isUuid(bookingId)) return null
  const auth = await pool.query(
    `SELECT b.user_id, l.host_id FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`,
    [bookingId]
  )
  const a = auth.rows[0]
  if (!a) return null
  const allowed = requester.role === 'admin' || requester.id === a.user_id || requester.id === a.host_id
  if (!allowed) return null
  return getStayGuideItems(bookingId)
}

/**
 * Host adds an item to one of THEIR confirmed bookings. Ownership + the confirmed
 * gate live in the INSERT ... SELECT itself, so a client-supplied host id can
 * never widen it: no matching (booking, host) row → no insert → null.
 * Omitting `order` appends the item to the end of the guide.
 */
export async function addStayGuideItem(
  bookingId: string,
  hostUserId: string,
  input: StayGuideInput,
): Promise<StayGuideItem | null> {
  if (!isUuid(bookingId) || !isUuid(hostUserId)) return null
  const kind = assertGuideKind(input.kind)
  const title = cleanGuideText(input.title, MAX_GUIDE_TITLE)
  const body = cleanGuideText(input.body, MAX_GUIDE_BODY)
  const url = cleanGuideUrl(kind, input.url)
  if (kind === 'info' && !title && !body) throw new Error('Add a title or some text for this item')
  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO stay_guide_items (booking_id, kind, title, body, url, "order")
       SELECT b.id, $3, $4, $5, $6,
              COALESCE($7::int, (SELECT COALESCE(max(x."order"), -1) + 1 FROM stay_guide_items x WHERE x.booking_id = b.id))
         FROM bookings b JOIN listings l ON l.id = b.listing_id
        WHERE b.id = $1 AND l.host_id = $2 AND b.status = 'confirmed'
       RETURNING *
     )
     SELECT ${GUIDE_COLS} FROM ins g`,
    [bookingId, hostUserId, kind, title, body, url, clampGuideOrder(input.order)]
  )
  return (rows[0] as StayGuideItem) ?? null
}

/** Host edits / reorders one of their items. `kind` is immutable (delete + re-add
 *  to change it) so the URL rules can't be swapped out from under an item.
 *  Only the fields present in `patch` change; ownership is enforced in the SQL. */
export async function updateStayGuideItem(
  bookingId: string,
  itemId: string,
  hostUserId: string,
  patch: { title?: unknown; body?: unknown; url?: unknown; order?: unknown },
): Promise<StayGuideItem | null> {
  if (!isUuid(bookingId) || !isUuid(itemId) || !isUuid(hostUserId)) return null
  // The item's own kind decides how a new URL is validated.
  const cur = await pool.query(
    `SELECT g.kind FROM stay_guide_items g
       JOIN bookings b ON b.id = g.booking_id
       JOIN listings l ON l.id = b.listing_id
      WHERE g.id = $1 AND b.id = $2 AND l.host_id = $3`,
    [itemId, bookingId, hostUserId]
  )
  if (!cur.rows[0]) return null
  const kind = cur.rows[0].kind as StayGuideKind
  const hasTitle = patch.title !== undefined
  const hasBody = patch.body !== undefined
  const hasUrl = patch.url !== undefined && kind !== 'info'
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE stay_guide_items g SET
         title = CASE WHEN $4::boolean THEN $5 ELSE g.title END,
         body  = CASE WHEN $6::boolean THEN $7 ELSE g.body END,
         url   = CASE WHEN $8::boolean THEN $9 ELSE g.url END,
         "order" = COALESCE($10::int, g."order")
       FROM bookings b, listings l
       WHERE g.id = $1 AND g.booking_id = b.id AND b.id = $2
         AND l.id = b.listing_id AND l.host_id = $3
       RETURNING g.*
     )
     SELECT ${GUIDE_COLS} FROM upd g`,
    [
      itemId, bookingId, hostUserId,
      hasTitle, hasTitle ? cleanGuideText(patch.title, MAX_GUIDE_TITLE) : null,
      hasBody, hasBody ? cleanGuideText(patch.body, MAX_GUIDE_BODY) : null,
      hasUrl, hasUrl ? cleanGuideUrl(kind, patch.url) : null,
      clampGuideOrder(patch.order),
    ]
  )
  return (rows[0] as StayGuideItem) ?? null
}

/** Host removes one of their items. True if a row was deleted. */
export async function deleteStayGuideItem(
  bookingId: string,
  itemId: string,
  hostUserId: string,
): Promise<boolean> {
  if (!isUuid(bookingId) || !isUuid(itemId) || !isUuid(hostUserId)) return false
  const { rowCount } = await pool.query(
    `DELETE FROM stay_guide_items g
      USING bookings b, listings l
      WHERE g.id = $1 AND g.booking_id = b.id AND b.id = $2
        AND l.id = b.listing_id AND l.host_id = $3`,
    [itemId, bookingId, hostUserId]
  )
  return (rowCount ?? 0) > 0
}

export interface StayPass {
  reservation_code: string | null
  title: string
  location: string | null
  region: string | null
  check_in: string
  check_out: string
  guests: number
  status: string
  payment_status: string
  host_notes: string | null
  guest_name: string | null
  host_name: string | null
  image: string | null
  /** Host-authored guide items (empty unless the stay is confirmed/completed). */
  guide: StayGuideItem[]
}

/** Normalize a code coming off a QR / URL segment. Returns null when there is no
 *  usable code — including the literal "null"/"undefined" that a client with an
 *  unconfirmed booking may have stringified into the link. A pending booking has
 *  reservation_code NULL, so it can never be reached by code at all. */
export function normalizeStayCode(code: unknown): string | null {
  const c = String(code ?? '').trim().toUpperCase()
  if (!c || c === 'NULL' || c === 'UNDEFINED' || c === 'NONE') return null
  return c
}

/** Public stay "pass" data, looked up by the reservation code embedded in the
 *  QR. Returns only non-sensitive fields (no emails/phones, no ids) so the QR
 *  link is safe to open by anyone holding the code. */
export async function getStayByCode(code: string): Promise<StayPass | null> {
  const c = normalizeStayCode(code)
  if (!c) return null
  const { rows } = await pool.query(
    `SELECT b.id, b.reservation_code,
            l.title, l.location, l.region,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.guests, b.status, COALESCE(b.payment_status, 'unpaid') AS payment_status,
            b.host_notes,
            (SELECT split_part(u.full_name, ' ', 1) FROM users u WHERE u.id = b.user_id) AS guest_name,
            (SELECT u.full_name FROM users u WHERE u.id = l.host_id) AS host_name,
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS image
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.reservation_code IS NOT NULL AND upper(b.reservation_code) = $1 LIMIT 1`,
    [c]
  )
  const row = rows[0] as (Omit<StayPass, 'guide'> & { id: string }) | undefined
  if (!row) return null
  const { id, ...pass } = row
  // The guide belongs to a live stay: once cancelled/rejected the host's content
  // (gate codes, directions…) stops being served. Best-effort so a dev DB without
  // the table still renders the pass.
  let guide: StayGuideItem[] = []
  if (pass.status === 'confirmed' || pass.status === 'completed') {
    try {
      guide = await getStayGuideItems(id)
    } catch (e) {
      console.error('stay guide unavailable (run the stay_guide_items migration):', e)
    }
  }
  return { ...pass, guide }
}

// ---- Reservation lifecycle: host listings + booking confirmation -------------

/** THE reservation-code generator — one format for every surface (backend, web,
 *  iOS, Android): "QK-" + 6 chars from an alphabet with no ambiguous glyphs, e.g.
 *  "QK-7F3K9Q". Never derive a code from the booking id; the stored column is the
 *  only truth, and it is written exactly once, at confirmation (see issueCodeSql). */
export function genReservationCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
  let s = ''
  for (let i = 0; i < 6; i++) s += alphabet[randomInt(0, alphabet.length)]
  return `QK-${s}`
}

export interface CreateListingInput {
  title: string
  description?: string
  location?: string
  country?: string
  pricePerNight: number
  bedrooms?: number
  beds?: number
  bathrooms?: number
  maxGuests?: number
  propertyType?: string
  region?: string
  /** Resort picked from the catalog. Wins over resortName. */
  resortId?: string | null
  /** Free text the host typed via "Other". Queued for admin review. */
  resortName?: string | null
  lat?: number
  lng?: number
  images?: string[]
  amenities?: string[]
  cancellationPolicy?: string
  ownershipDoc?: string
  weeklyDiscount?: number
  monthlyDiscount?: number
  weekendPrice?: number | null
  monthlyPrices?: unknown
}

/** Clamp a percent discount to 0..90 (integers). */
function clampDiscount(v: unknown): number {
  const n = Math.floor(Number(v) || 0)
  return Math.max(0, Math.min(90, n))
}

/** A positive nightly price, or null. */
function cleanPrice(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** Keep only months "1".."12" → positive price. Returns a JSON string for jsonb. */
function cleanMonthlyPrices(v: unknown): string {
  const out: Record<string, number> = {}
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const m = Number(k)
      const p = cleanPrice(val)
      if (Number.isInteger(m) && m >= 1 && m <= 12 && p) out[String(m)] = p
    }
  }
  return JSON.stringify(out)
}

/** A host (or admin) creates a listing. Returns the full listing with images. */
export async function createListing(hostUserId: string, input: CreateListingInput): Promise<Listing> {
  if (!isUuid(hostUserId)) throw new Error('Invalid host id')
  if (!input.title || !input.title.trim()) throw new Error('Title is required')
  const price = Number(input.pricePerNight)
  if (!Number.isFinite(price) || price <= 0) throw new Error('Price must be a positive number')

  // New listings enter the moderation queue: unpublished + 'pending' until an
  // admin approves them (S7). Ownership doc (if provided) is stored for review.
  const ownershipDoc = typeof input.ownershipDoc === 'string' && /^(data:image\/|https?:\/\/)/i.test(input.ownershipDoc) && input.ownershipDoc.length < 3_500_000
    ? input.ownershipDoc
    : null
  // The resort decides the region — that is the point of a resort belonging to one.
  // An unknown typed name is kept as free text AND queued for /ops.
  const resort = await resolveResortSelection({
    resortId: input.resortId,
    resortName: input.resortName,
    region: input.region ?? null,
    userId: hostUserId,
  })
  const { rows } = await pool.query(
    `INSERT INTO listings
       (host_id, title, description, location, country, price_per_night, currency,
        bedrooms, beds, bathrooms, max_guests, property_type, region, lat, lng, listing_code, is_published, amenities,
        cancellation_policy, approval_status, ownership_doc, weekly_discount, monthly_discount, weekend_price, monthly_prices,
        resort_id, resort_name)
     VALUES ($1,$2,$3,$4,$5,$6,'EGP',$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16,$17,'pending',$18,$19,$20,$21,$22::jsonb,$23,$24)
     RETURNING id`,
    [
      hostUserId, input.title.trim(), input.description ?? null, input.location ?? null, input.country ?? null,
      price, Math.max(0, Math.floor(input.bedrooms ?? 1)), Math.max(0, Math.floor(input.beds ?? 1)),
      Math.max(0, Math.floor(input.bathrooms ?? 1)), Math.max(1, Math.floor(input.maxGuests ?? 2)),
      input.propertyType ?? 'Apartment', resort.region, input.lat ?? null, input.lng ?? null, genReservationCode(),
      input.amenities ?? [], normalizePolicy(input.cancellationPolicy), ownershipDoc,
      clampDiscount(input.weeklyDiscount), clampDiscount(input.monthlyDiscount),
      cleanPrice(input.weekendPrice), cleanMonthlyPrices(input.monthlyPrices),
      resort.resort_id, resort.resort_name,
    ]
  )
  const id = rows[0].id as string
  const images = (input.images ?? []).filter((u) => typeof u === 'string' && u.trim()).slice(0, 10)
  for (let i = 0; i < images.length; i++) {
    await pool.query(`INSERT INTO listing_images (listing_id, url, "order") VALUES ($1,$2,$3)`, [id, images[i].trim(), i])
  }
  const created = await getListingById(id)
  if (!created) throw new Error('Failed to create listing')
  // New listings await admin approval before going live (S7).
  await createNotification(hostUserId, {
    type: 'listing_submitted',
    title: 'Listing submitted for review',
    body: `“${created.title}” is under review. We’ll let you know once it’s approved.`,
    link: '/host',
  })
  await sendPush(hostUserId, {
    title: 'Listing submitted for review',
    body: `${created.title} — pending approval`,
    link: '/host',
  })
  return created
}

/** A host's own listings. */
export async function getHostListings(hostUserId: string): Promise<Listing[]> {
  if (!isUuid(hostUserId)) return []
  const { rows } = await pool.query(
    `SELECT ${LISTING_COLS} FROM listings l WHERE l.host_id = $1 ORDER BY l.created_at DESC`,
    [hostUserId]
  )
  return rows as Listing[]
}

/** Host confirms or rejects a PENDING booking for one of THEIR listings. Returns null if not allowed. */
export async function setBookingStatus(
  bookingId: string,
  hostUserId: string,
  status: 'confirmed' | 'rejected'
): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(hostUserId)) return null
  // Approving is THE confirmation transition — the reservation code (and with it the
  // guest's QR / wallet pass / stay link) is born here. Declining leaves it NULL.
  await pool.query(
    `UPDATE bookings b SET status = $3,
            ${issueCodeSql(`$3 = 'confirmed'`, '$4')},
            -- B3: the cancelled_* columns record who ENDED a booking, for any
            -- terminal transition. A host cannot "cancel" in this system — declining
            -- a pending request is their only termination — so it is attributed here
            -- as role 'host'. Without this the cancellation report could never show
            -- a host at all.
            cancelled_at      = CASE WHEN $3 = 'rejected' THEN COALESCE(b.cancelled_at, now()) ELSE b.cancelled_at END,
            cancelled_by      = CASE WHEN $3 = 'rejected' THEN $2::text ELSE b.cancelled_by END,
            cancelled_by_role = CASE WHEN $3 = 'rejected' THEN 'host' ELSE b.cancelled_by_role END
       FROM listings l
      WHERE b.id = $1 AND b.listing_id = l.id AND l.host_id = $2 AND b.status = 'pending'`,
    [bookingId, hostUserId, status, genReservationCode()]
  )
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.id = $1 AND l.host_id = $2`,
    [bookingId, hostUserId]
  )
  const updated = (rows[0] as Booking) ?? null
  // Notify the guest that the host confirmed/declined their request — in-app + push + email.
  if (updated) {
    const confirmed = status === 'confirmed'
    await createNotification(updated.user_id, {
      type: `booking_${status}`,
      title: confirmed ? 'Reservation confirmed' : 'Reservation declined',
      body: `Your stay at ${updated.title}`,
      link: `/reservation/${updated.id}`,
    })
    await sendPush(updated.user_id, {
      title: confirmed ? 'Reservation confirmed 🎉' : 'Reservation update',
      body: confirmed ? `Your stay at ${updated.title} is confirmed` : `Your request for ${updated.title} wasn’t accepted`,
      link: `/reservation/${updated.id}`,
    })
    const guestEmail = await userEmail(updated.user_id)
    if (guestEmail) {
      if (confirmed) {
        await sendNotificationEmail(
          guestEmail,
          'Your reservation is confirmed 🎉 — QuickIn',
          'Your stay is confirmed',
          [
            `Your reservation at <strong>${updated.title}</strong> is confirmed.`,
            `Dates: ${updated.check_in} → ${updated.check_out}.`,
            `Reservation code: <strong>${updated.reservation_code ?? ''}</strong>.`,
          ],
          { label: 'View reservation', url: `${WEB_URL}/reservation/${updated.id}` }
        )
      } else {
        await sendNotificationEmail(
          guestEmail,
          'Update on your reservation — QuickIn',
          'Your request wasn’t accepted',
          [
            `Unfortunately your request for <strong>${updated.title}</strong> wasn’t accepted this time.`,
            'There are plenty of other boutique stays waiting for you.',
          ],
          { label: 'Explore stays', url: `${WEB_URL}/explore` }
        )
      }
    }
  }
  return updated
}

/** All bookings across a host's listings (host "requests" view). */
export async function getHostBookings(hostUserId: string): Promise<Booking[]> {
  if (!isUuid(hostUserId)) return []
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE l.host_id = $1 ORDER BY b.created_at DESC`,
    [hostUserId]
  )
  return rows as Booking[]
}

/** A single reservation (for the detail card / QR / wallet pass). */
export async function getBookingById(bookingId: string): Promise<Booking | null> {
  if (!isUuid(bookingId)) return null
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`,
    [bookingId]
  )
  return (rows[0] as Booking) ?? null
}

// ---- Instapay manual payment (app_settings + payment_proofs) -----------------
// Flow: guest transfers via Instapay, uploads a screenshot at booking time
// (payment 'submitted') → host accepts (confirmed + paid) or rejects → guest may
// dispute a rejection → admin resolves. See scripts/migrate-instapay.mjs.

const MAX_PROOF_BYTES = 3_500_000

/** Validate a base64 data-URL (or https URL) screenshot, matching the id_verifications convention. */
function assertProofImage(src: unknown): string {
  const v = String(src ?? '').trim()
  if (!/^data:image\//i.test(v) && !/^https?:\/\//i.test(v)) {
    throw new Error('Please attach a screenshot of your transfer')
  }
  if (v.length > MAX_PROOF_BYTES) throw new Error('That screenshot is too large (max ~3.5MB)')
  return v
}

/** Read one admin setting (null if unset). */
export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key])
  return rows[0] ? ((rows[0].value as string | null) ?? null) : null
}

/** Upsert an admin setting. `updatedBy` is a user id or 'admin' (free text). */
export async function setSetting(key: string, value: string, updatedBy: string | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, value, updatedBy]
  )
}

/**
 * The public-facing Instapay destination shown to guests at checkout: the
 * handle/number, the optional deep link, and the optional admin-uploaded QR.
 * Rows that were never saved read as '' — no migration is needed to add a key.
 */
export async function getPaymentConfig(): Promise<PaymentConfig> {
  const { rows } = await pool.query(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
    [Object.values(INSTAPAY_KEYS)]
  )
  return rowsToPaymentConfig(rows as Array<{ key: string; value: string | null }>)
}

/**
 * Guest uploads a transfer screenshot for their booking. Inserts a payment_proofs
 * row, flips payment_status → 'submitted', and (if the host had rejected) reopens
 * the booking to 'pending' for re-review. Only the booking's owner, never on an
 * already-paid booking. Returns the updated booking (or null if not theirs).
 */
export async function submitPaymentProof(
  bookingId: string,
  userId: string,
  imageData: string,
  method = 'instapay',
): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(userId)) return null
  const img = assertProofImage(imageData)
  const m = method === 'instapay' ? 'instapay' : String(method).slice(0, 32)
  const cur = await pool.query(
    `SELECT payment_status FROM bookings WHERE id = $1 AND user_id = $2`,
    [bookingId, userId]
  )
  if (!cur.rows[0]) return null
  if (cur.rows[0].payment_status === 'paid') throw new Error('This booking is already paid')

  await pool.query(
    `INSERT INTO payment_proofs (booking_id, method, image_data, amount)
     VALUES ($1, $2, $3, (SELECT total_price FROM bookings WHERE id = $1))`,
    [bookingId, m, img]
  )
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET
         payment_status = 'submitted',
         payment_method = $3,
         status = CASE WHEN b.status = 'rejected' THEN 'pending' ELSE b.status END
       WHERE b.id = $1 AND b.user_id = $2
       RETURNING b.*
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, userId, m]
  )
  const booking = (rows[0] as Booking) ?? null
  if (booking) {
    // The GUEST is told their part is done. This used to notify only the host, with
    // "Payment to review" and a link to /host — but hosts no longer confirm transfers
    // (the money goes to QuickIn's account, and an admin decides), so that message
    // asked them to do something they can't. The host is still told money arrived.
    await createNotification(userId, {
      type: 'payment_submitted',
      title: 'Transfer received',
      body: `We got your screenshot for ${booking.title}. We'll confirm it shortly.`,
      link: '/reservations',
    })
    if (booking.host_id) {
      await createNotification(booking.host_id, {
        type: 'payment_submitted',
        title: 'Guest sent a payment',
        body: `${booking.title} — QuickIn is confirming the transfer`,
        link: '/host',
      })
      await sendPush(booking.host_id, {
        title: 'Guest sent a payment',
        body: `${booking.title} — ${booking.reservation_code ?? ''}`,
        link: '/host',
      })
    }
  }
  return booking
}

export interface PaymentProof {
  image_data: string
  method: string
  status: string
  submitted_at: string
  reject_reason: string | null
  dispute_note: string | null
  amount: number | null
}

/** The latest transfer screenshot for a booking. Authorized to the booking's
 *  guest, the listing's host, or an admin — else null. */
export async function getBookingProof(
  bookingId: string,
  requester: { id: string; role: string },
): Promise<PaymentProof | null> {
  if (!isUuid(bookingId)) return null
  const auth = await pool.query(
    `SELECT b.user_id, l.host_id FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`,
    [bookingId]
  )
  const a = auth.rows[0]
  if (!a) return null
  const allowed = requester.role === 'admin' || requester.id === a.user_id || requester.id === a.host_id
  if (!allowed) return null
  const { rows } = await pool.query(
    `SELECT image_data, method, status,
            to_char(submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS submitted_at,
            reject_reason, dispute_note, amount::float8 AS amount
       FROM payment_proofs WHERE booking_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
    [bookingId]
  )
  return (rows[0] as PaymentProof) ?? null
}

/**
 * Host accepts or rejects a booking's payment (doubles as accepting the stay).
 * Accept → booking 'confirmed' + payment 'paid'. Reject → 'rejected' + reason.
 * Only the listing's host, only while the booking is 'pending'. Updates the
 * latest proof row and notifies the guest. Returns null if not the host / not pending.
 */
// hostReviewPayment was removed with the payment-flow change: hosts no longer approve
// transfers, an admin does (adminReviewProof). It was also unreachable in practice —
// it required b.status = 'pending' while a guest can only pay once a booking is
// 'confirmed', so a normal screenshot could never be approved through it.
export async function guestDisputePayment(
  bookingId: string,
  userId: string,
  note: string | null = null,
): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(userId)) return null
  const latest = await pool.query(
    `SELECT pp.id, pp.status FROM payment_proofs pp
       JOIN bookings b ON b.id = pp.booking_id
      WHERE pp.booking_id = $1 AND b.user_id = $2
      ORDER BY pp.submitted_at DESC LIMIT 1`,
    [bookingId, userId]
  )
  const l = latest.rows[0]
  if (!l) return null
  if (l.status !== 'rejected') throw new Error('Only a rejected payment can be disputed')
  await pool.query(
    `UPDATE payment_proofs SET status = 'disputed', dispute_note = $2, disputed_at = now() WHERE id = $1`,
    [l.id, note ? String(note).slice(0, 1000) : null]
  )
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET payment_status = 'disputed' WHERE b.id = $1 AND b.user_id = $2 RETURNING b.*
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, userId]
  )
  return (rows[0] as Booking) ?? null
}

export interface DisputeRow {
  booking_id: string
  reservation_code: string | null
  title: string
  guest_id: string
  guest_name: string | null
  guest_email: string | null
  host_id: string | null
  total_price: number
  reject_reason: string | null
  dispute_note: string | null
  submitted_at: string | null
  disputed_at: string | null
}

/** All open payment disputes (latest proof still 'disputed'), for the admin queue. */
export async function adminListDisputes(): Promise<DisputeRow[]> {
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, b.reservation_code, l.title,
            b.user_id AS guest_id,
            (SELECT full_name FROM users u WHERE u.id = b.user_id) AS guest_name,
            (SELECT email     FROM users u WHERE u.id = b.user_id) AS guest_email,
            l.host_id, b.total_price::float8 AS total_price,
            pp.reject_reason, pp.dispute_note,
            to_char(pp.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS submitted_at,
            to_char(pp.disputed_at,  'YYYY-MM-DD"T"HH24:MI:SS') AS disputed_at
       FROM payment_proofs pp
       JOIN bookings b ON b.id = pp.booking_id
       JOIN listings l ON l.id = b.listing_id
      WHERE pp.status = 'disputed'
        AND pp.id = (SELECT id FROM payment_proofs p2 WHERE p2.booking_id = pp.booking_id ORDER BY p2.submitted_at DESC LIMIT 1)
      ORDER BY pp.disputed_at DESC NULLS LAST`
  )
  return rows as DisputeRow[]
}

/** Admin resolves a dispute. Approve → confirm + mark paid; Uphold → keep rejected.
 *  Not constrained to 'pending' (a rejected booking can be revived). Notifies guest (+ host on approve). */
export async function adminResolveDispute(
  bookingId: string,
  adminId: string,
  action: 'approve' | 'uphold',
  note: string | null = null,
): Promise<Booking | null> {
  if (!isUuid(bookingId)) return null
  const approve = action === 'approve'
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET
         status = CASE WHEN $2 THEN 'confirmed' ELSE 'rejected' END,
         payment_status = CASE WHEN $2 THEN 'paid' ELSE 'rejected' END,
         paid_at = CASE WHEN $2 THEN COALESCE(b.paid_at, now()) ELSE b.paid_at END,
         -- Upholding the guest ("I did pay") confirms the stay → issue the code.
         ${issueCodeSql('$2', '$3')}
       WHERE b.id = $1
       RETURNING b.*
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, approve, genReservationCode()]
  )
  const booking = (rows[0] as Booking) ?? null
  if (!booking) return null
  await pool.query(
    `UPDATE payment_proofs SET
        status = CASE WHEN $2 THEN 'approved' ELSE 'rejected' END,
        reviewed_by = $3, reviewed_at = now(),
        reject_reason = CASE WHEN $2 THEN NULL ELSE COALESCE($4, reject_reason) END
      WHERE id = (SELECT id FROM payment_proofs WHERE booking_id = $1 ORDER BY submitted_at DESC LIMIT 1)`,
    [bookingId, approve, String(adminId).slice(0, 64), note ? String(note).slice(0, 500) : null]
  )
  await createNotification(booking.user_id, {
    type: approve ? 'payment_approved' : 'payment_rejected',
    title: approve ? 'Payment confirmed' : 'Payment dispute closed',
    body: approve
      ? `Your stay at ${booking.title} is confirmed`
      : `${booking.title}: the transfer could not be verified`,
    link: `/reservation/${booking.id}`,
  })
  await sendPush(booking.user_id, {
    title: approve ? 'Booking confirmed 🎉' : 'Payment update',
    body: booking.title,
    link: `/reservation/${booking.id}`,
  })
  if (approve && booking.host_id) {
    await createNotification(booking.host_id, {
      type: 'booking_paid',
      title: 'Booking paid',
      body: `${booking.title} — payment confirmed by admin`,
      link: '/host',
    })
  }
  return booking
}

// ---- Host applications ("become a host" → admin review → approve) -----------
// Mirrors the web's helpers (quickin-master/src/lib/local/db.ts) so both projects
// behave identically against the shared Neon DB. Applying NEVER grants hosting —
// only an admin approval flips users.is_host.

export const HOST_TYPES = ['individual', 'company', 'brokerage'] as const
export type HostType = (typeof HOST_TYPES)[number]

/** Derived host state every client reads on launch to gate host surfaces. */
export type HostStatus = 'none' | 'pending' | 'rejected' | 'approved'

export interface HostState {
  is_host: boolean
  host_type: string | null
  host_status: HostStatus
  host_review_note: string | null
}

export interface HostApplication {
  id: string
  user_id: string
  email?: string
  full_name: string | null
  national_id: string | null
  phone: string | null
  address: string | null
  company: string | null
  host_type: string | null
  notes: string | null
  status: 'pending' | 'approved' | 'rejected'
  submitted_at: string
  reviewed_at: string | null
  review_note: string | null
}

// host_applications has no host_type column (canonical schema) — the choice is
// persisted on users.host_type at apply time and read back through the join.
const HOST_APP_COLS = `a.id, a.user_id, a.full_name, a.national_id, a.phone, a.address, a.company,
            u.host_type, a.notes, a.status,
            to_char(a.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS submitted_at,
            to_char(a.reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS reviewed_at,
            a.review_note`

/** Legacy rule: is_host = true ALWAYS means approved, even with no application
 *  row, so pre-existing hosts keep working. Conversely 'approved' is never taken
 *  from the application alone — users.is_host is the only source of host access. */
function deriveHostStatus(isHost: boolean, appStatus: string | null): HostStatus {
  if (isHost) return 'approved'
  if (appStatus === 'pending') return 'pending'
  if (appStatus === 'rejected') return 'rejected'
  return 'none'
}

function hostStateOf(isHost: boolean, hostType: string | null, appStatus: string | null, note: string | null): HostState {
  const status = deriveHostStatus(isHost, appStatus)
  return {
    is_host: isHost,
    host_type: hostType ?? null,
    host_status: status,
    host_review_note: status === 'rejected' ? (note ?? null) : null, // the note only ever explains a rejection
  }
}

/** The authoritative host fields for a user — returned by /api/auth/me and every
 *  auth response so a client can validate host access on each launch. */
export async function getHostState(userId: string): Promise<HostState> {
  const none: HostState = { is_host: false, host_type: null, host_status: 'none', host_review_note: null }
  if (!isUuid(userId)) return none
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(u.is_host, false) AS is_host, u.host_type, a.status, a.review_note
         FROM users u LEFT JOIN host_applications a ON a.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    )
    const r = rows[0]
    return r ? hostStateOf(Boolean(r.is_host), r.host_type, r.status, r.review_note) : none
  } catch (e) {
    // host_applications is absent on an old dev DB — fall back to users.is_host
    // alone so sign-in never breaks and legacy hosts still read as approved.
    console.error('getHostState fell back to users.is_host:', e)
    const { rows } = await pool.query(`SELECT COALESCE(is_host, false) AS is_host, host_type FROM users WHERE id = $1`, [userId])
    const r = rows[0]
    return r ? hostStateOf(Boolean(r.is_host), r.host_type, null, null) : none
  }
}

/** Spread the host fields onto a user payload so login / verify-otp / social all
 *  return exactly the shape /api/auth/me does. */
export async function withHostState<T extends { id: string }>(user: T): Promise<T & HostState> {
  return { ...user, ...(await getHostState(user.id)) }
}

/** The signed-in user's application, or null when they never applied. */
export async function getHostApplication(userId: string): Promise<HostApplication | null> {
  if (!isUuid(userId)) return null
  const { rows } = await pool.query(
    `SELECT ${HOST_APP_COLS}
       FROM host_applications a JOIN users u ON u.id = a.user_id
      WHERE a.user_id = $1`,
    [userId]
  )
  return (rows[0] as HostApplication) ?? null
}

/** Submit (or re-submit after a rejection) an application: upserts on the
 *  UNIQUE (user_id) constraint, back to 'pending' with the old review cleared.
 *  Does NOT touch users.is_host. Callers validate the fields first. */
export async function submitHostApplication(
  userId: string,
  f: {
    full_name: string
    national_id: string
    phone: string
    address: string
    host_type: HostType
    company?: string | null
    notes?: string | null
  }
): Promise<HostApplication | null> {
  if (!isUuid(userId)) throw new Error('Invalid user')
  const company = f.host_type === 'individual' ? null : (f.company || null)
  const vals = [userId, f.full_name, f.national_id, f.phone, f.address, company, f.notes || null]
  const upd = await pool.query(
    `UPDATE host_applications
        SET full_name = $2, national_id = $3, phone = $4, address = $5, company = $6, notes = $7,
            status = 'pending', submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL, review_note = NULL
      WHERE user_id = $1 RETURNING id`,
    vals
  )
  if (!upd.rows[0]) {
    await pool.query(
      `INSERT INTO host_applications (user_id, full_name, national_id, phone, address, company, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      vals
    )
  }
  // Persist the host type + company on the user (same as the web) so listings can
  // show a "Company"/"Brokerage" badge once the application is approved.
  await pool.query(`UPDATE users SET host_type = $2, company = $3 WHERE id = $1`, [userId, f.host_type, company])
  return getHostApplication(userId)
}

/** Admin queue — applications with the applicant's email. Defaults to 'pending'. */
export async function listHostApplications(status = 'pending'): Promise<HostApplication[]> {
  const filterable = status === 'pending' || status === 'approved' || status === 'rejected'
  const { rows } = await pool.query(
    `SELECT ${HOST_APP_COLS}, u.email
       FROM host_applications a JOIN users u ON u.id = a.user_id
      ${filterable ? 'WHERE a.status = $1' : ''}
      ORDER BY a.submitted_at ASC`,
    filterable ? [status] : []
  )
  return rows as HostApplication[]
}

/** Admin decision, keyed by the APPLICANT (like admin/verifications). Approve
 *  flips users.is_host AND stamps the application in ONE transaction; reject only
 *  stamps the application. Both notify the applicant. */
export async function reviewHostApplication(
  userId: string,
  action: 'approve' | 'reject',
  note: string | null
): Promise<HostApplication | null> {
  if (!isUuid(userId)) return null
  const approve = action === 'approve'
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE host_applications
          SET status = $2, reviewed_at = now(), reviewed_by = 'admin', review_note = $3
        WHERE user_id = $1 RETURNING id`,
      [userId, approve ? 'approved' : 'rejected', note]
    )
    if (!rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    if (approve) {
      // The applicant's host_type was stored on the user when they applied (legacy
      // rows default to 'individual'). role='host' keeps the backend's own flag in sync.
      await client.query(
        `UPDATE users SET is_host = true, role = 'host', host_type = COALESCE(host_type, 'individual') WHERE id = $1`,
        [userId]
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  // Notify after the commit (best-effort, like the listing/verification flows).
  await createNotification(userId, {
    type: 'host',
    title: approve ? 'You are now a host!' : 'Host application update',
    body: approve
      ? 'Your host application was approved — you can now list your space and accept guests.'
      : note
        ? `Your application needs attention: ${note}`
        : 'Your host application was not approved this time.',
    link: approve ? '/host' : '/account',
  })
  await sendPush(userId, {
    title: approve ? 'You are now a host 🎉' : 'Host application update',
    body: approve ? 'Your application was approved — start listing your space.' : 'Tap to see what needs attention.',
    link: approve ? '/host' : '/account',
  })
  return getHostApplication(userId)
}

// ---- ID verification (id_verifications table — shared with web /ops admin) ---

export type VerificationTableStatus = 'unverified' | 'pending' | 'verified' | 'rejected'

export interface VerificationTableState {
  status: VerificationTableStatus
  verified_at: string | null
}

/** Submit FRONT (+ optional BACK) ID photos for review → upserts the user's
 *  PENDING row in id_verifications (the table the web /ops admin reads), so
 *  mobile-submitted IDs are visible to admins. Reuses an existing pending row.
 *  Stores FRONT→image_data, BACK→back_image_data, source='manual',
 *  status='pending'. */
export async function submitVerificationImages(args: {
  userId: string
  front: string
  back?: string | null
  idNumber?: string | null
  fullName?: string | null
}): Promise<VerificationTableState> {
  const { userId, front, back = null, idNumber = null, fullName = null } = args
  if (!isUuid(userId)) throw new Error('Invalid user')
  const f = String(front ?? '').trim()
  if (!/^data:image\//i.test(f) && !/^https?:\/\//i.test(f)) {
    throw new Error('Please attach a photo of the front of your ID')
  }
  if (f.length > 3_500_000) throw new Error('That front image is too large')
  const b = back == null ? null : String(back).trim() || null
  if (b && !/^data:image\//i.test(b) && !/^https?:\/\//i.test(b)) {
    throw new Error('Please attach a valid photo of the back of your ID')
  }
  if (b && b.length > 3_500_000) throw new Error('That back image is too large')

  const existing = await pool.query(
    `SELECT id FROM id_verifications WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
    [userId]
  )
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE id_verifications
          SET image_data = $2, back_image_data = $3,
              id_number = COALESCE($4, id_number),
              full_name = COALESCE($5, full_name),
              source = 'manual', status = 'pending',
              submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL, notes = NULL
        WHERE id = $1`,
      [existing.rows[0].id, f, b, idNumber, fullName]
    )
  } else {
    await pool.query(
      `INSERT INTO id_verifications (user_id, image_data, back_image_data, id_number, full_name, source, status)
       VALUES ($1, $2, $3, $4, $5, 'manual', 'pending')`,
      [userId, f, b, idNumber, fullName]
    )
  }
  return { status: 'pending', verified_at: null }
}

/** The signed-in user's verification status, read from the latest
 *  id_verifications row. Defaults to 'unverified' when no row exists.
 *  verified_at is the review timestamp once status is 'verified'. */
export async function getVerificationStatusFromTable(userId: string): Promise<VerificationTableState> {
  if (!isUuid(userId)) return { status: 'unverified', verified_at: null }
  const { rows } = await pool.query(
    `SELECT status,
            CASE WHEN status = 'verified'
                 THEN to_char(reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS') END AS verified_at
       FROM id_verifications
      WHERE user_id = $1
      ORDER BY submitted_at DESC
      LIMIT 1`,
    [userId]
  )
  const r = rows[0]
  if (!r) return { status: 'unverified', verified_at: null }
  return {
    status: (r.status as VerificationTableStatus) ?? 'unverified',
    verified_at: r.verified_at ?? null,
  }
}

// ---- Chat: per-booking messages between guest and host ----------------------

export interface Message {
  id: string
  booking_id: string
  sender_id: string
  sender_name: string | null
  body: string
  created_at: string
}

/** All messages for a booking, oldest first, with the sender's display name. */
export async function getBookingMessages(bookingId: string): Promise<Message[]> {
  if (!isUuid(bookingId)) return []
  const { rows } = await pool.query(
    `SELECT m.id, m.booking_id, m.sender_id, u.full_name AS sender_name, m.body, m.created_at
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.booking_id = $1
      ORDER BY m.created_at ASC`,
    [bookingId]
  )
  return rows as Message[]
}

/** Post a message to a booking thread. Phone numbers are blocked by any trick
 *  (see contentguard) — including splitting a number across several messages. */
export async function createMessage(bookingId: string, senderId: string, body: string): Promise<Message> {
  if (!isUuid(bookingId) || !isUuid(senderId)) throw new Error('Invalid id')
  const text = String(body || '').trim().slice(0, 2000)
  if (!text) throw new Error('Message cannot be empty')

  // Block phone numbers — this single message, or completing one split across the
  // sender's recent messages in this thread.
  if (containsPhoneNumber(text)) throw new Error(PHONE_BLOCK_MESSAGE)
  const recent = await pool.query(
    `SELECT body FROM messages WHERE booking_id = $1 AND sender_id = $2 ORDER BY created_at DESC LIMIT 16`,
    [bookingId, senderId]
  )
  const priorBodies = recent.rows.map((r) => String(r.body || '')).reverse()
  if (combinesIntoPhoneNumber(priorBodies, text)) throw new Error(PHONE_BLOCK_MESSAGE)

  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO messages (booking_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *
     )
     SELECT ins.id, ins.booking_id, ins.sender_id, u.full_name AS sender_name, ins.body, ins.created_at
       FROM ins JOIN users u ON u.id = ins.sender_id`,
    [bookingId, senderId, text]
  )
  return rows[0] as Message
}

// ---- Place autocomplete (search-by-place typeahead) -------------------------

const CURATED_PLACES = [
  'Giza', 'North Coast', 'Sahel', 'El Gouna', 'Cairo', 'Zamalek', 'New Cairo',
  'Sheikh Zayed', '6th of October', 'Maadi', 'Hurghada', 'Sharm El Sheikh',
  'Alexandria', 'Marina', 'Ain Sokhna', 'Dahab', 'Luxor', 'Aswan',
]

/** Up to 8 place suggestions: distinct listing locations matching q, merged with
 *  a curated list of well-known Egyptian destinations. Empty q → curated list. */
export async function getPlaceSuggestions(q: string): Promise<string[]> {
  const query = (q || '').trim()
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    const k = p.trim().toLowerCase()
    if (!p.trim() || seen.has(k)) return
    seen.add(k); out.push(p.trim())
  }
  if (!query) {
    CURATED_PLACES.slice(0, 8).forEach(push)
    return out
  }
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT location FROM listings
        WHERE location IS NOT NULL AND location ILIKE '%' || $1 || '%'
        ORDER BY location LIMIT 8`,
      [query]
    )
    for (const r of rows) push(String(r.location))
  } catch { /* fall back to curated matches */ }
  CURATED_PLACES.filter((p) => p.toLowerCase().includes(query.toLowerCase())).forEach(push)
  return out.slice(0, 8)
}

// ---- Pre-booking chat (guest ⇄ host, before a booking exists) ---------------
// Uses the shared conversations + chat_messages tables (created by the web via
// xmig6). Distinct from the per-booking `messages` table above.

export interface ConversationSummary {
  id: string
  listing_id: string | null
  listing_title: string | null
  listing_image: string | null
  other_name: string | null
  last_message: string | null
  last_message_at: string
  is_host: boolean
}

export interface ChatThreadMessage {
  id: string
  sender_id: string
  body: string
  created_at: string
  mine?: boolean
}

/** Guest opens (or reuses) a thread with the listing's host. Returns the thread id. */
export async function getOrCreateConversation(
  guestId: string,
  listingId: string
): Promise<{ id: string; host_id: string; listing_title: string | null }> {
  if (!isUuid(guestId) || !isUuid(listingId)) throw new Error('Invalid id')
  const { rows: lr } = await pool.query(`SELECT host_id, title FROM listings WHERE id = $1`, [listingId])
  const listing = lr[0] as { host_id: string | null; title: string | null } | undefined
  if (!listing) throw new Error('Listing not found')
  if (!listing.host_id || !isUuid(listing.host_id)) throw new Error('This listing has no host to message yet')
  if (listing.host_id === guestId) throw new Error("You can't message your own listing")
  const { rows } = await pool.query(
    `INSERT INTO conversations (listing_id, guest_id, host_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (listing_id, guest_id) DO UPDATE SET listing_id = EXCLUDED.listing_id
     RETURNING id`,
    [listingId, guestId, listing.host_id]
  )
  return { id: rows[0].id as string, host_id: listing.host_id, listing_title: listing.title }
}

/** All threads a user is part of (as guest or host), newest activity first. */
export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT c.id, c.listing_id,
            l.title AS listing_title,
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS listing_image,
            CASE WHEN c.guest_id = $1 THEN hu.full_name ELSE gu.full_name END AS other_name,
            (SELECT m.body FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            to_char(c.last_message_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_message_at,
            (c.host_id = $1) AS is_host
       FROM conversations c
       LEFT JOIN listings l ON l.id = c.listing_id
       LEFT JOIN users gu ON gu.id = c.guest_id
       LEFT JOIN users hu ON hu.id = c.host_id
      WHERE c.guest_id = $1 OR c.host_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT 200`,
    [userId]
  )
  return rows as ConversationSummary[]
}

async function conversationForUser(userId: string, conversationId: string) {
  const { rows } = await pool.query(
    `SELECT id, listing_id, guest_id, host_id FROM conversations
      WHERE id = $1 AND (guest_id = $2 OR host_id = $2)`,
    [conversationId, userId]
  )
  return rows[0] as { id: string; listing_id: string | null; guest_id: string; host_id: string } | undefined
}

/** Messages in a thread, oldest first. Only members can read. */
export async function listChatMessages(userId: string, conversationId: string): Promise<ChatThreadMessage[]> {
  if (!isUuid(userId) || !isUuid(conversationId)) throw new Error('Invalid id')
  const convo = await conversationForUser(userId, conversationId)
  if (!convo) throw new Error('Conversation not found')
  const { rows } = await pool.query(
    `SELECT id, sender_id, body, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500`,
    [conversationId]
  )
  return (rows as ChatThreadMessage[]).map((m) => ({ ...m, mine: m.sender_id === userId }))
}

/** Post a message. Phone numbers are blocked (contentguard). Notifies the other party. */
export async function postChatMessage(userId: string, conversationId: string, rawBody: string): Promise<ChatThreadMessage> {
  if (!isUuid(userId) || !isUuid(conversationId)) throw new Error('Invalid id')
  const body = String(rawBody || '').trim().slice(0, 2000)
  if (!body) throw new Error('Message is empty')
  if (containsPhoneNumber(body)) throw new Error(PHONE_BLOCK_MESSAGE)
  const convo = await conversationForUser(userId, conversationId)
  if (!convo) throw new Error('Conversation not found')
  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *
     ), upd AS ( UPDATE conversations SET last_message_at = now() WHERE id = $1 )
     SELECT id, sender_id, body, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at FROM ins`,
    [conversationId, userId, body]
  )
  const other = convo.guest_id === userId ? convo.host_id : convo.guest_id
  await createNotification(other, { type: 'message', title: 'New message', body: body.slice(0, 80), link: '/messages' })
  const msg = rows[0] as ChatThreadMessage
  return { ...msg, mine: true }
}

/**
 * Record a user sign-in (F1) — the ONE activity event that can't be derived, because
 * nothing else in the schema records that a user logged in: no last_login_at, and no
 * user session table (auth is a stateless 30-day JWT). The web project's /ops activity
 * feed reads this table; both projects write it, since the mobile apps sign in here.
 *
 * Best-effort by design: a logging failure must never stop someone signing in.
 */
export async function recordLogin(
  userId: string,
  method: 'password' | 'otp' | 'google' | 'apple' | 'social',
  req?: Request,
): Promise<void> {
  try {
    if (!isUuid(userId)) return
    const ip = req
      ? (req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || null)
      : null
    const ua = req ? (req.headers.get('user-agent') || '').slice(0, 300) || null : null
    await pool.query(
      `INSERT INTO user_logins (user_id, method, ip, user_agent) VALUES ($1, $2, $3, $4)`,
      [userId, method, ip, ua],
    )
  } catch {
    /* never block a sign-in over telemetry */
  }
}
