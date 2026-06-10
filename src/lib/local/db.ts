import { pool } from './pool'

// Data access via node-postgres (parameterized queries). Works locally and on
// Vercel/Neon. No Supabase, no psql CLI.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export interface ListingImage {
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
  currency: string
  bedrooms: number | null
  beds: number | null
  bathrooms: number | null
  max_guests: number | null
  property_type: string | null
  is_guest_favorite: boolean
  listing_code: string | null
  lat: number | null
  lng: number | null
  listing_images: ListingImage[]
}

export interface SearchFilters {
  location?: string
  guests?: number
  checkIn?: string
  checkOut?: string
}

export interface Booking {
  id: string
  listing_id: string
  check_in: string
  check_out: string
  guests: number
  total_price: number
  status: string
  created_at: string
  title: string
  location: string | null
  image: string | null
}

const LISTING_COLS = `
  l.id, l.title, l.description, l.location, l.country,
  l.price_per_night::float8 AS price_per_night, l.currency,
  l.bedrooms, l.beds, l.bathrooms, l.max_guests, l.property_type,
  l.is_guest_favorite, l.listing_code, l.lat::float8 AS lat, l.lng::float8 AS lng,
  COALESCE(
    (SELECT json_agg(json_build_object('url', li.url, 'order', li."order") ORDER BY li."order")
     FROM listing_images li WHERE li.listing_id = l.id), '[]'
  ) AS listing_images
`

export async function getListings(filters: SearchFilters = {}): Promise<Listing[]> {
  const where: string[] = ['l.is_published = true']
  const params: unknown[] = []

  if (filters.location && filters.location.trim()) {
    params.push('%' + filters.location.trim() + '%')
    where.push(`l.location ILIKE $${params.length}`)
  }
  if (filters.guests && Number.isFinite(filters.guests) && filters.guests > 0) {
    params.push(Math.floor(filters.guests))
    where.push(`COALESCE(l.max_guests, 0) >= $${params.length}`)
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
    )`)
  }

  const { rows } = await pool.query(
    `SELECT ${LISTING_COLS} FROM listings l
     WHERE ${where.join(' AND ')}
     ORDER BY l.is_guest_favorite DESC, l.created_at DESC`,
    params
  )
  return rows as Listing[]
}

export async function getListingById(id: string): Promise<Listing | null> {
  if (!isUuid(id)) return null
  const { rows } = await pool.query(`SELECT ${LISTING_COLS} FROM listings l WHERE l.id = $1`, [id])
  return (rows[0] as Listing) ?? null
}

// ---- Bookings ---------------------------------------------------------------

const BOOKING_COLS = `
  b.id, b.listing_id,
  to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
  to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
  b.guests, b.total_price::float8 AS total_price, b.status,
  to_char(b.created_at, 'YYYY-MM-DD') AS created_at,
  l.title, l.location,
  (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS image
`

export interface CreateBookingInput {
  listingId: string
  userId: string
  checkIn: string
  checkOut: string
  guests: number
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
       AND check_in < $2 AND check_out > $3 LIMIT 1`,
    [listingId, checkOut, checkIn]
  )
  if (clash.rowCount && clash.rowCount > 0) throw new Error('Those dates are not available')

  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO bookings (listing_id, user_id, check_in, check_out, guests, total_price, status)
       SELECT $1, $2, $3, $4, $5, ($4::date - $3::date) * l.price_per_night, 'confirmed'
       FROM listings l WHERE l.id = $1
       RETURNING *
     )
     SELECT ${BOOKING_COLS} FROM ins b JOIN listings l ON l.id = b.listing_id`,
    [listingId, userId, checkIn, checkOut, g]
  )
  if (!rows[0]) throw new Error('Could not create booking (listing not found)')
  return rows[0] as Booking
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
