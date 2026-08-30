import { randomInt } from 'node:crypto'
import { pool } from './pool'
import { createNotification } from './notifications'
import { COMMISSION_RATE_SQL, sqlWithCommission } from './commission-core'
import { canReactivate } from './host-visibility-core'

// Services = a "booking system" for standalone experiences (jet ski, diving, tours…).
// A host posts a service; a user "subscribes"/requests it; like a booking it goes
// pending -> confirmed/rejected, and only the owning host can confirm.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

/** Short request code shown on the card, e.g. "SV-7F3K9Q". */
function genServiceCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
  let s = ''
  for (let i = 0; i < 6; i++) s += alphabet[randomInt(0, alphabet.length)]
  return `SV-${s}`
}

export interface Service {
  id: string
  host_id: string
  host_name: string | null
  title: string
  description: string | null
  category: string | null
  location: string | null
  /** Guest projection: commission-inclusive. Host projection: the host's raw price. */
  price: number
  /** Host projection only — what a guest is quoted. */
  guest_price?: number
  commission_rate?: number
  currency: string
  image_url: string | null
  lat: number | null
  lng: number | null
  is_published: boolean
  /** HOST PROJECTION ONLY. The host took this service down themselves — the
   *  services twin of listings.unpublished_by_host. */
  unpublished_by_host?: boolean
  /** HOST PROJECTION ONLY. Requests still waiting on this host — the number a
   *  deactivate would decline. */
  pending_request_count?: number
  created_at: string
}

export interface ServiceRequest {
  id: string
  service_id: string
  user_id: string
  status: string
  preferred_date: string | null
  note: string | null
  request_code: string | null
  created_at: string
  // joined service + people context (enough for both the user's and host's views)
  service_title: string
  service_category: string | null
  service_image: string | null
  service_price: number
  service_currency: string
  service_location: string | null
  host_id: string
  host_name: string | null
  requester_name: string | null
  requester_email: string | null
}

// Services carry the platform commission exactly like listings do: services.price
// is the host's RAW price, and a guest is quoted price × (1 + rate). Which one
// lands in `price` is decided by the projection — see the note above LISTING_COLS
// in db.ts. Services have no snapshot column (there is no payment flow yet), so
// they always price at the LIVE rate.

/** Guest projection — `price` includes the commission, raw is never returned. */
export const SERVICE_COLS = `
  s.id, s.host_id, u.full_name AS host_name, s.title, s.description, s.category,
  s.location, ${sqlWithCommission('s.price')}::float8 AS price, s.currency, s.image_url, s.lat, s.lng,
  ${COMMISSION_RATE_SQL}::float8 AS commission_rate,
  s.is_published, s.created_at`

/** Host projection — `price` is the host's raw amount (what they edit), plus a
 *  read-only `guest_price` for "guests pay X". Never serve this to a guest. */
export const SERVICE_COLS_HOST = `
  s.id, s.host_id, u.full_name AS host_name, s.title, s.description, s.category,
  s.location, s.price::float8 AS price, s.currency, s.image_url, s.lat, s.lng,
  ${sqlWithCommission('s.price')}::float8 AS guest_price,
  ${COMMISSION_RATE_SQL}::float8 AS commission_rate,
  s.is_published, s.created_at,
  -- Host projection only: WHY it is down, and what taking it down would cost.
  -- A service has no moderation queue, so the host's own flag is the only reason
  -- one is ever unpublished — but it is still read rather than inferred from
  -- is_published, so the two can never drift.
  COALESCE(s.unpublished_by_host, false) AS unpublished_by_host,
  (SELECT count(*) FROM service_requests r
    WHERE r.service_id = s.id AND r.status = 'pending')::int AS pending_request_count`
export const SERVICE_FROM = `services s JOIN users u ON u.id = s.host_id`

const REQUEST_COLS = `
  r.id, r.service_id, r.user_id, r.status, r.preferred_date, r.note, r.request_code, r.created_at,
  s.title AS service_title, s.category AS service_category, s.image_url AS service_image,
  ${sqlWithCommission('s.price')}::float8 AS service_price, s.currency AS service_currency, s.location AS service_location,
  s.host_id AS host_id, hu.full_name AS host_name,
  ru.full_name AS requester_name, ru.email AS requester_email`
const REQUEST_FROM = `service_requests r
  JOIN services s ON s.id = r.service_id
  JOIN users hu ON hu.id = s.host_id
  JOIN users ru ON ru.id = r.user_id`

// ---- Services ----------------------------------------------------------------

export interface CreateServiceInput {
  title: string
  description?: string | null
  category?: string | null
  location?: string | null
  price?: number
  imageUrl?: string | null
  lat?: number | null
  lng?: number | null
}

/** A host (or admin) posts a service. */
export async function createService(hostUserId: string, input: CreateServiceInput): Promise<Service> {
  if (!isUuid(hostUserId)) throw new Error('Invalid host id')
  if (!input.title || !input.title.trim()) throw new Error('Title is required')
  const price = Number(input.price ?? 0)
  if (!Number.isFinite(price) || price < 0) throw new Error('Price must be a non-negative number')

  const { rows } = await pool.query(
    `INSERT INTO services (host_id, title, description, category, location, price, currency, image_url, lat, lng, is_published)
     VALUES ($1,$2,$3,$4,$5,$6,'EGP',$7,$8,$9,true) RETURNING id`,
    [
      hostUserId, input.title.trim(), input.description ?? null, input.category ?? null,
      input.location ?? null, price, input.imageUrl ?? null, input.lat ?? null, input.lng ?? null,
    ]
  )
  const created = await getServiceById(rows[0].id as string, { asHost: true })
  if (!created) throw new Error('Failed to create service')
  return created
}

/** All published services (the browse list). */
export async function getServices(): Promise<Service[]> {
  const { rows } = await pool.query(
    `SELECT ${SERVICE_COLS} FROM ${SERVICE_FROM} WHERE s.is_published = true ORDER BY s.created_at DESC`
  )
  return rows as Service[]
}

/** One service. Defaults to the GUEST projection; pass `{ asHost: true }` when
 *  the response goes to the owning host (create/update round-trips especially,
 *  since the host PATCHes the price straight back). */
export async function getServiceById(id: string, opts: { asHost?: boolean } = {}): Promise<Service | null> {
  if (!isUuid(id)) return null
  const cols = opts.asHost ? SERVICE_COLS_HOST : SERVICE_COLS
  const { rows } = await pool.query(`SELECT ${cols} FROM ${SERVICE_FROM} WHERE s.id = $1`, [id])
  return (rows[0] as Service) ?? null
}

/** A host's own services — raw prices, with guest_price alongside. */
export async function getHostServices(hostUserId: string): Promise<Service[]> {
  if (!isUuid(hostUserId)) return []
  const { rows } = await pool.query(
    `SELECT ${SERVICE_COLS_HOST} FROM ${SERVICE_FROM} WHERE s.host_id = $1 ORDER BY s.created_at DESC`,
    [hostUserId]
  )
  return rows as Service[]
}

/** What `hostSetServicePublished` did — the services twin of
 *  HostVisibilityResult in db.ts. */
export interface HostServiceVisibilityResult {
  id: string
  is_published: boolean
  unpublished_by_host: boolean
  /** Requests declined by a deactivate. Always 0 on a reactivate. */
  declined_requests: number
  service: Service | null
}

/**
 * The host takes their own service off the market, or puts it back.
 *
 * Same contract as hostSetListingPublished (db.ts) and for the same reason: there
 * is no host-facing DELETE, because service_requests hang off this row and
 * deleting it would cascade away a guest's booked experience. Deactivating sets
 * `is_published = false` — getServices stops returning it and createServiceRequest
 * now refuses it — and declines every request still waiting on the host, through
 * the same setServiceRequestStatus a manual decline uses so each subscriber gets
 * the ordinary "declined" notification.
 *
 * Simpler than the listings twin in one way: services have no moderation queue
 * and no identity gate of their own, so the host's flag is the ONLY reason one is
 * ever down. A reactivate therefore always goes live, and there is no
 * `blocked_by` to report.
 *
 * Returns null when the service isn't this host's.
 */
export async function hostSetServicePublished(
  serviceId: string,
  hostUserId: string,
  next: boolean,
): Promise<HostServiceVisibilityResult | null> {
  if (!isUuid(serviceId) || !isUuid(hostUserId)) return null

  const { rows: current } = await pool.query(
    `SELECT COALESCE(unpublished_by_host, false) AS unpublished_by_host
       FROM services WHERE id = $1 AND host_id = $2`,
    [serviceId, hostUserId],
  )
  const row = current[0] as { unpublished_by_host: boolean } | undefined
  if (!row) return null

  // Putting a service back is only ever the host releasing their own grip — see
  // the rule in host-visibility-core.ts. A service that is down without the flag
  // was taken down by staff and is not the host's to republish.
  if (next && !canReactivate(row)) {
    return {
      id: serviceId,
      is_published: false,
      unpublished_by_host: false,
      declined_requests: 0,
      service: await getServiceById(serviceId, { asHost: true }),
    }
  }

  // Visibility first, declines second: no request can slip into the window
  // between the two and survive the sweep.
  await pool.query(
    `UPDATE services SET is_published = $3, unpublished_by_host = $4
      WHERE id = $1 AND host_id = $2`,
    [serviceId, hostUserId, next, !next],
  )

  let declined = 0
  if (!next) {
    const { rows: pending } = await pool.query(
      `SELECT id FROM service_requests WHERE service_id = $1 AND status = 'pending'`,
      [serviceId],
    )
    for (const p of pending as { id: string }[]) {
      // Best-effort per request: one subscriber's notification failing must not
      // leave the rest waiting on a service that is already gone.
      try {
        if (await setServiceRequestStatus(p.id, hostUserId, 'rejected')) declined++
      } catch (err) {
        console.error('deactivate service: failed to decline request', p.id, err)
      }
    }
  }

  return {
    id: serviceId,
    is_published: next,
    unpublished_by_host: !next,
    declined_requests: declined,
    service: await getServiceById(serviceId, { asHost: true }),
  }
}

// ---- Service requests ("subscriptions") -------------------------------------

/** A user requests/subscribes to a service → status 'pending'. */
export async function createServiceRequest(
  userId: string,
  input: { serviceId: string; preferredDate?: string | null; note?: string | null }
): Promise<ServiceRequest> {
  if (!isUuid(userId) || !isUuid(input.serviceId)) throw new Error('Invalid id')
  if (input.preferredDate && !isDate(input.preferredDate)) throw new Error('Invalid date (use YYYY-MM-DD)')

  // One pending request per user+service.
  const dup = await pool.query(
    `SELECT 1 FROM service_requests WHERE service_id=$1 AND user_id=$2 AND status='pending' LIMIT 1`,
    [input.serviceId, userId]
  )
  if (dup.rowCount && dup.rowCount > 0) throw new Error('You already have a pending request for this service')

  // The browse list already hides an unpublished service, but a request can
  // arrive with a service id straight from a deep link or a stale client, so the
  // rule is enforced here too — exactly as createBooking does it for listings.
  // Without this, a host "removing" their service would only hide it from the
  // list while still taking new requests through the back door.
  const { rows } = await pool.query(
    `INSERT INTO service_requests (service_id, user_id, status, preferred_date, note, request_code)
     SELECT $1, $2, 'pending', $3, $4, $5 FROM services
      WHERE id = $1 AND COALESCE(is_published, false) = true
     RETURNING id`,
    [input.serviceId, userId, input.preferredDate ?? null, input.note ?? null, genServiceCode()]
  )
  if (!rows[0]) {
    const { rowCount } = await pool.query(`SELECT 1 FROM services WHERE id = $1`, [input.serviceId])
    throw new Error(rowCount ? 'This service is not available right now' : 'Service not found')
  }
  const created = await getServiceRequestById(rows[0].id as string)
  if (!created) throw new Error('Failed to create request')
  // Notify the host of the new service request.
  await createNotification(created.host_id, {
    type: 'service_request',
    title: 'New service request',
    body: `Someone requested ${created.service_title}`,
    link: '/host',
  })
  return created
}

export async function getServiceRequestById(id: string): Promise<ServiceRequest | null> {
  if (!isUuid(id)) return null
  const { rows } = await pool.query(`SELECT ${REQUEST_COLS} FROM ${REQUEST_FROM} WHERE r.id = $1`, [id])
  return (rows[0] as ServiceRequest) ?? null
}

/** The signed-in user's subscriptions. */
export async function getUserServiceRequests(userId: string): Promise<ServiceRequest[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLS} FROM ${REQUEST_FROM} WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
    [userId]
  )
  return rows as ServiceRequest[]
}

/** Requests across all of a host's services (host inbox). */
export async function getHostServiceRequests(hostUserId: string): Promise<ServiceRequest[]> {
  if (!isUuid(hostUserId)) return []
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLS} FROM ${REQUEST_FROM} WHERE s.host_id = $1 ORDER BY r.created_at DESC`,
    [hostUserId]
  )
  return rows as ServiceRequest[]
}

/** Host confirms or rejects a PENDING request for one of THEIR services. Null if not allowed. */
export async function setServiceRequestStatus(
  requestId: string,
  hostUserId: string,
  status: 'confirmed' | 'rejected'
): Promise<ServiceRequest | null> {
  if (!isUuid(requestId) || !isUuid(hostUserId)) return null
  await pool.query(
    `UPDATE service_requests r SET status = $3
       FROM services s
      WHERE r.id = $1 AND r.service_id = s.id AND s.host_id = $2 AND r.status = 'pending'`,
    [requestId, hostUserId, status]
  )
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLS} FROM ${REQUEST_FROM} WHERE r.id = $1 AND s.host_id = $2`,
    [requestId, hostUserId]
  )
  const updated = (rows[0] as ServiceRequest) ?? null
  // Notify the subscriber that the host confirmed/declined their request.
  if (updated) {
    await createNotification(updated.user_id, {
      type: `service_${status}`,
      title: status === 'confirmed' ? 'Service request confirmed' : 'Service request declined',
      body: updated.service_title,
      link: '/subscriptions',
    })
  }
  return updated
}
