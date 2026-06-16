import { pool } from './pool'
import { createNotification } from './notifications'
import { sendPush } from './push'
import { sendNotificationEmail } from './mailer'

const WEB_URL = process.env.WEB_URL || 'https://quickin-frontend.vercel.app'

// Admin data access — list every entity and delete any of them. Used only by the
// admin-gated routes under /api/local/admin/*. Never exposes password hashes/OTPs.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

// The reservation lifecycle the admin can drive. "confirmed" = booked,
// "completed" = stay ended (which unlocks the guest's review).
export const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'rejected', 'cancelled'] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export async function getAllUsers() {
  // password_plain is PROTOTYPE-ONLY (so the admin can display passwords); it's null
  // for accounts created before this existed and for social (Google/Apple) sign-ins.
  const { rows } = await pool.query(
    `SELECT id, email, full_name, role, provider, email_verified, password_plain, country,
            COALESCE(verification_status, 'unverified') AS verification_status, created_at
       FROM users ORDER BY created_at DESC NULLS LAST`
  )
  return rows
}

export async function getAllListings() {
  const { rows } = await pool.query(
    `SELECT l.id, l.title, l.location, l.country, l.price_per_night::float8 AS price_per_night,
            l.is_published, l.region,
            COALESCE((SELECT round(avg(rv.rating)::numeric,2) FROM reviews rv WHERE rv.listing_id = l.id),0)::float8 AS rating,
            COALESCE((SELECT count(*) FROM reviews rv WHERE rv.listing_id = l.id),0)::int AS review_count,
            l.host_id, u.email AS host_email, u.full_name AS host_name, l.created_at
       FROM listings l LEFT JOIN users u ON u.id = l.host_id
      ORDER BY l.created_at DESC NULLS LAST`
  )
  return rows
}

export async function getAllBookings() {
  const { rows } = await pool.query(
    `SELECT b.id, b.reservation_code, b.status, b.check_in, b.check_out, b.guests,
            b.total_price::float8 AS total_price, l.title AS listing_title,
            gu.email AS guest_email, b.created_at
       FROM bookings b
       LEFT JOIN listings l ON l.id = b.listing_id
       LEFT JOIN users gu ON gu.id = b.user_id
      ORDER BY b.created_at DESC NULLS LAST`
  )
  return rows
}

export async function getAllServices() {
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.category, s.location, s.price::float8 AS price,
            s.host_id, u.email AS host_email, u.full_name AS host_name, s.created_at
       FROM services s LEFT JOIN users u ON u.id = s.host_id
      ORDER BY s.created_at DESC NULLS LAST`
  )
  return rows
}

export async function getAllServiceRequests() {
  const { rows } = await pool.query(
    `SELECT r.id, r.request_code, r.status, s.title AS service_title,
            ru.email AS requester_email, r.created_at
       FROM service_requests r
       LEFT JOIN services s ON s.id = r.service_id
       LEFT JOIN users ru ON ru.id = r.user_id
      ORDER BY r.created_at DESC NULLS LAST`
  )
  return rows
}

/** Registered FCM/APNs device push tokens, with the owning account. */
export async function getAllDeviceTokens() {
  const { rows } = await pool.query(
    `SELECT d.id, d.token, d.platform, d.created_at,
            u.email AS user_email, u.full_name AS user_name, u.role AS user_role
       FROM device_tokens d LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at DESC NULLS LAST`
  )
  return rows
}

/** Everything, in one shot, for the admin dashboard. */
export async function getAdminOverview() {
  const [users, listings, bookings, services, serviceRequests, deviceTokens] = await Promise.all([
    getAllUsers(),
    getAllListings(),
    getAllBookings(),
    getAllServices(),
    getAllServiceRequests(),
    getAllDeviceTokens(),
  ])
  return {
    users,
    listings,
    bookings,
    services,
    serviceRequests,
    deviceTokens,
    counts: {
      users: users.length,
      listings: listings.length,
      bookings: bookings.length,
      services: services.length,
      serviceRequests: serviceRequests.length,
      deviceTokens: deviceTokens.length,
    },
  }
}

// entity slug (as used in the URL) -> real table name. Whitelist = no SQL injection.
const TABLES: Record<string, string> = {
  users: 'users',
  listings: 'listings',
  bookings: 'bookings',
  services: 'services',
  'service-requests': 'service_requests',
  'device-tokens': 'device_tokens',
}

/** Delete any row by entity slug + id. Deleting a user also removes the listings
 *  they host (whose bookings/images cascade), since listings.host_id has no
 *  ON DELETE CASCADE; the user's own bookings/services/requests cascade on delete. */
export async function deleteEntity(entity: string, id: string): Promise<{ deleted: boolean }> {
  const table = TABLES[entity]
  if (!table) throw new Error('Unknown entity')
  if (!isUuid(id)) throw new Error('Invalid id')

  if (table === 'users') {
    await pool.query(`DELETE FROM listings WHERE host_id = $1`, [id])
    const r = await pool.query(`DELETE FROM users WHERE id = $1`, [id])
    return { deleted: (r.rowCount ?? 0) > 0 }
  }
  const r = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id])
  return { deleted: (r.rowCount ?? 0) > 0 }
}

/** Admin drives a reservation's lifecycle (pending → confirmed → completed, or
 *  rejected/cancelled). Marking it "completed" lets the guest leave a review.
 *  Notifies the guest (in-app). */
export async function adminSetBookingStatus(
  bookingId: string,
  status: string
): Promise<{ updated: boolean; status: string }> {
  if (!isUuid(bookingId)) throw new Error('Invalid id')
  if (!(BOOKING_STATUSES as readonly string[]).includes(status)) throw new Error('Invalid status')
  const { rows } = await pool.query(
    `UPDATE bookings b SET status = $2
       FROM listings l
      WHERE b.id = $1 AND l.id = b.listing_id
      RETURNING b.user_id, l.title`,
    [bookingId, status]
  )
  const row = rows[0]
  if (row) {
    const completed = status === 'completed'
    await createNotification(row.user_id, {
      type: `booking_${status}`,
      title: completed ? 'Your stay is complete' : `Reservation ${status}`,
      body: completed
        ? `How was ${row.title}? Tap to leave a review.`
        : `Your reservation for ${row.title} is now ${status}.`,
      link: `/reservation/${bookingId}`,
    })
  }
  return { updated: rows.length > 0, status }
}

/** Admin activates / deactivates a listing (its published state). An inactive
 *  listing disappears from search/explore but isn't deleted. */
export async function adminSetListingPublished(
  id: string,
  isPublished: boolean
): Promise<{ updated: boolean; is_published: boolean }> {
  if (!isUuid(id)) throw new Error('Invalid id')
  const { rows } = await pool.query(
    `UPDATE listings SET is_published = $2 WHERE id = $1 RETURNING host_id, title`,
    [id, isPublished]
  )
  const row = rows[0] as { host_id: string | null; title: string } | undefined
  if (row?.host_id) {
    await createNotification(row.host_id, {
      type: isPublished ? 'listing_approved' : 'listing_deactivated',
      title: isPublished ? 'Your listing is approved' : 'Your listing was deactivated',
      body: isPublished
        ? `“${row.title}” is now live and visible to guests.`
        : `“${row.title}” is hidden from guests for now.`,
      link: '/host',
    })
    await sendPush(row.host_id, {
      title: isPublished ? 'Listing approved 🎉' : 'Listing deactivated',
      body: `“${row.title}”`,
      link: '/host',
    })
    const u = await pool.query(`SELECT email FROM users WHERE id = $1`, [row.host_id])
    const email = u.rows[0]?.email
    if (email) {
      await sendNotificationEmail(
        email,
        isPublished ? 'Your QuickIn listing is approved 🎉' : 'Your QuickIn listing was deactivated',
        isPublished ? 'Your listing is live' : 'Listing deactivated',
        [
          isPublished
            ? `“${row.title}” has been approved and is now visible to guests on QuickIn.`
            : `“${row.title}” is temporarily hidden from guests.`,
        ],
        { label: 'Open host dashboard', url: `${WEB_URL}/host` }
      )
    }
  }
  return { updated: rows.length > 0, is_published: isPublished }
}

/**
 * Admin broadcast — "fire a notification" to web/iOS/Android users. Writes an
 * in-app notification for every targeted user, sends an FCM push (if a device
 * token + FIREBASE_SERVICE_ACCOUNT exist), and optionally an email. Best-effort
 * per user — one failure never aborts the rest.
 */
export async function adminBroadcast(args: {
  title: string
  body?: string | null
  link?: string | null
  audience?: 'all' | 'guests' | 'hosts'
  push?: boolean
  email?: boolean
}): Promise<{ recipients: number; emailed: number }> {
  const title = (args.title ?? '').toString().trim()
  if (!title) throw new Error('Title is required')
  const body = (args.body ?? '').toString().trim() || null
  const link = (args.link ?? '').toString().trim() || null
  const audience = args.audience === 'guests' ? 'guests' : args.audience === 'hosts' ? 'hosts' : 'all'

  const filter =
    audience === 'guests' ? `role = 'user'` : audience === 'hosts' ? `role IN ('host','admin')` : `true`
  const { rows } = await pool.query(`SELECT id, email FROM users WHERE ${filter}`)

  let emailed = 0
  for (const u of rows as { id: string; email: string | null }[]) {
    await createNotification(u.id, { type: 'announcement', title, body, link })
    if (args.push !== false) {
      await sendPush(u.id, { title, body, link })
    }
    if (args.email && u.email) {
      await sendNotificationEmail(
        u.email,
        title,
        title,
        body ? [body] : ['You have a new update from QuickIn.'],
        link ? { label: 'Open QuickIn', url: link.startsWith('http') ? link : `${WEB_URL}${link}` } : undefined
      )
      emailed++
    }
  }
  return { recipients: rows.length, emailed }
}

/** Admin changes a user's role (user | host | admin). */
export async function updateUserRole(id: string, role: string): Promise<{ updated: boolean; role: string }> {
  if (!isUuid(id)) throw new Error('Invalid id')
  const r = role === 'host' ? 'host' : role === 'admin' ? 'admin' : 'user'
  const res = await pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [id, r])
  return { updated: (res.rowCount ?? 0) > 0, role: r }
}
