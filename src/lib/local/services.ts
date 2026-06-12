import { randomInt } from 'node:crypto'
import { pool } from './pool'

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
  price: number
  currency: string
  image_url: string | null
  lat: number | null
  lng: number | null
  is_published: boolean
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

const SERVICE_COLS = `
  s.id, s.host_id, u.full_name AS host_name, s.title, s.description, s.category,
  s.location, s.price::float8 AS price, s.currency, s.image_url, s.lat, s.lng,
  s.is_published, s.created_at`
const SERVICE_FROM = `services s JOIN users u ON u.id = s.host_id`

const REQUEST_COLS = `
  r.id, r.service_id, r.user_id, r.status, r.preferred_date, r.note, r.request_code, r.created_at,
  s.title AS service_title, s.category AS service_category, s.image_url AS service_image,
  s.price::float8 AS service_price, s.currency AS service_currency, s.location AS service_location,
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
     VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,true) RETURNING id`,
    [
      hostUserId, input.title.trim(), input.description ?? null, input.category ?? null,
      input.location ?? null, price, input.imageUrl ?? null, input.lat ?? null, input.lng ?? null,
    ]
  )
  const created = await getServiceById(rows[0].id as string)
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

export async function getServiceById(id: string): Promise<Service | null> {
  if (!isUuid(id)) return null
  const { rows } = await pool.query(`SELECT ${SERVICE_COLS} FROM ${SERVICE_FROM} WHERE s.id = $1`, [id])
  return (rows[0] as Service) ?? null
}

/** A host's own services. */
export async function getHostServices(hostUserId: string): Promise<Service[]> {
  if (!isUuid(hostUserId)) return []
  const { rows } = await pool.query(
    `SELECT ${SERVICE_COLS} FROM ${SERVICE_FROM} WHERE s.host_id = $1 ORDER BY s.created_at DESC`,
    [hostUserId]
  )
  return rows as Service[]
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

  const { rows } = await pool.query(
    `INSERT INTO service_requests (service_id, user_id, status, preferred_date, note, request_code)
     SELECT $1, $2, 'pending', $3, $4, $5 FROM services WHERE id = $1
     RETURNING id`,
    [input.serviceId, userId, input.preferredDate ?? null, input.note ?? null, genServiceCode()]
  )
  if (!rows[0]) throw new Error('Service not found')
  const created = await getServiceRequestById(rows[0].id as string)
  if (!created) throw new Error('Failed to create request')
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
  return (rows[0] as ServiceRequest) ?? null
}
