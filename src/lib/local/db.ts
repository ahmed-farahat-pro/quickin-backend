import { pool } from './pool'
import { randomInt } from 'node:crypto'

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
  user_id: string
  check_in: string
  check_out: string
  guests: number
  total_price: number
  status: string
  created_at: string
  title: string
  location: string | null
  image: string | null
  reservation_code: string | null
  host_id: string | null
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
  b.id, b.listing_id, b.user_id, b.reservation_code,
  to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
  to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
  b.guests, b.total_price::float8 AS total_price, b.status,
  to_char(b.created_at, 'YYYY-MM-DD') AS created_at,
  l.title, l.location, l.host_id,
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

  const reservationCode = genReservationCode()
  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO bookings (listing_id, user_id, check_in, check_out, guests, total_price, status, reservation_code)
       SELECT $1, $2, $3, $4, $5, ($4::date - $3::date) * l.price_per_night, 'pending', $6
       FROM listings l WHERE l.id = $1
       RETURNING *
     )
     SELECT ${BOOKING_COLS} FROM ins b JOIN listings l ON l.id = b.listing_id`,
    [listingId, userId, checkIn, checkOut, g, reservationCode]
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

// ---- Reservation lifecycle: host listings + booking confirmation -------------

/** Short reservation code shown on the card + encoded in the QR, e.g. "QK-7F3K9Q". */
function genReservationCode(): string {
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
  lat?: number
  lng?: number
  images?: string[]
}

/** A host (or admin) creates a listing. Returns the full listing with images. */
export async function createListing(hostUserId: string, input: CreateListingInput): Promise<Listing> {
  if (!isUuid(hostUserId)) throw new Error('Invalid host id')
  if (!input.title || !input.title.trim()) throw new Error('Title is required')
  const price = Number(input.pricePerNight)
  if (!Number.isFinite(price) || price <= 0) throw new Error('Price must be a positive number')

  const { rows } = await pool.query(
    `INSERT INTO listings
       (host_id, title, description, location, country, price_per_night, currency,
        bedrooms, beds, bathrooms, max_guests, property_type, lat, lng, listing_code, is_published)
     VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,$12,$13,$14,true)
     RETURNING id`,
    [
      hostUserId, input.title.trim(), input.description ?? null, input.location ?? null, input.country ?? null,
      price, Math.max(0, Math.floor(input.bedrooms ?? 1)), Math.max(0, Math.floor(input.beds ?? 1)),
      Math.max(0, Math.floor(input.bathrooms ?? 1)), Math.max(1, Math.floor(input.maxGuests ?? 2)),
      input.propertyType ?? 'Apartment', input.lat ?? null, input.lng ?? null, genReservationCode(),
    ]
  )
  const id = rows[0].id as string
  const images = (input.images ?? []).filter((u) => typeof u === 'string' && u.trim()).slice(0, 10)
  for (let i = 0; i < images.length; i++) {
    await pool.query(`INSERT INTO listing_images (listing_id, url, "order") VALUES ($1,$2,$3)`, [id, images[i].trim(), i])
  }
  const created = await getListingById(id)
  if (!created) throw new Error('Failed to create listing')
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
  await pool.query(
    `UPDATE bookings b SET status = $3
       FROM listings l
      WHERE b.id = $1 AND b.listing_id = l.id AND l.host_id = $2 AND b.status = 'pending'`,
    [bookingId, hostUserId, status]
  )
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.id = $1 AND l.host_id = $2`,
    [bookingId, hostUserId]
  )
  return (rows[0] as Booking) ?? null
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

/** Post a message to a booking thread. */
export async function createMessage(bookingId: string, senderId: string, body: string): Promise<Message> {
  if (!isUuid(bookingId) || !isUuid(senderId)) throw new Error('Invalid id')
  const text = String(body || '').trim().slice(0, 2000)
  if (!text) throw new Error('Message cannot be empty')
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
