import { pool } from './pool'

// Admin data access — list every entity and delete any of them. Used only by the
// admin-gated routes under /api/local/admin/*. Never exposes password hashes/OTPs.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

export async function getAllUsers() {
  // password_plain is PROTOTYPE-ONLY (so the admin can display passwords); it's null
  // for accounts created before this existed and for social (Google/Apple) sign-ins.
  const { rows } = await pool.query(
    `SELECT id, email, full_name, role, provider, email_verified, password_plain, created_at
       FROM users ORDER BY created_at DESC NULLS LAST`
  )
  return rows
}

export async function getAllListings() {
  const { rows } = await pool.query(
    `SELECT l.id, l.title, l.location, l.country, l.price_per_night::float8 AS price_per_night,
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

/** Everything, in one shot, for the admin dashboard. */
export async function getAdminOverview() {
  const [users, listings, bookings, services, serviceRequests] = await Promise.all([
    getAllUsers(),
    getAllListings(),
    getAllBookings(),
    getAllServices(),
    getAllServiceRequests(),
  ])
  return {
    users,
    listings,
    bookings,
    services,
    serviceRequests,
    counts: {
      users: users.length,
      listings: listings.length,
      bookings: bookings.length,
      services: services.length,
      serviceRequests: serviceRequests.length,
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

/** Admin changes a user's role (user | host | admin). */
export async function updateUserRole(id: string, role: string): Promise<{ updated: boolean; role: string }> {
  if (!isUuid(id)) throw new Error('Invalid id')
  const r = role === 'host' ? 'host' : role === 'admin' ? 'admin' : 'user'
  const res = await pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [id, r])
  return { updated: (res.rowCount ?? 0) > 0, role: r }
}
