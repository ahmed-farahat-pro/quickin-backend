// Every photo of one listing, for the /ops photo viewer. Staff see the gallery
// whatever the listing's state — pending, rejected, hidden by host or by staff —
// which is exactly when the public GET /api/local/listings/:id answers 404.
// Ordering and url hygiene live in admin-listing-photos-core.ts (unit-tested).
import { pool } from './pool'
import { toAdminListingPhotos, type AdminListingPhoto } from './admin-listing-photos-core'

export interface AdminListingPhotos {
  listing_id: string
  title: string
  photos: AdminListingPhoto[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** null when the id is malformed or no such listing exists. */
export async function adminGetListingPhotos(listingId: string): Promise<AdminListingPhotos | null> {
  if (!UUID_RE.test(listingId)) return null
  const { rows: listing } = await pool.query(`SELECT id, title FROM listings WHERE id = $1`, [listingId])
  if (!listing[0]) return null
  const { rows } = await pool.query(
    `SELECT id, url, "order" FROM listing_images WHERE listing_id = $1 ORDER BY "order", id`,
    [listingId]
  )
  return {
    listing_id: String(listing[0].id),
    title: String(listing[0].title ?? ''),
    photos: toAdminListingPhotos(rows),
  }
}
