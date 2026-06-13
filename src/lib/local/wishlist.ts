import { pool } from './pool'
import { LISTING_COLS, type Listing } from './db'
import { SERVICE_COLS, SERVICE_FROM, type Service } from './services'

// Wishlist: a signed-in user saves any listing OR service. One row per
// (user, item_type, item_id). getWishlist returns the full saved objects so the
// client can render cards directly.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)
export type WishItemType = 'listing' | 'service'

export async function addToWishlist(userId: string, itemType: WishItemType, itemId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(itemId)) return false
  const type = itemType === 'service' ? 'service' : 'listing'
  await pool.query(
    `INSERT INTO wishlists (user_id, item_type, item_id) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, item_type, item_id) DO NOTHING`,
    [userId, type, itemId]
  )
  return true
}

export async function removeFromWishlist(userId: string, itemType: WishItemType, itemId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(itemId)) return false
  const type = itemType === 'service' ? 'service' : 'listing'
  await pool.query(
    `DELETE FROM wishlists WHERE user_id = $1 AND item_type = $2 AND item_id = $3`,
    [userId, type, itemId]
  )
  return true
}

/** Toggle: returns the new saved-state (true = now saved). */
export async function toggleWishlist(userId: string, itemType: WishItemType, itemId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(itemId)) return false
  const type = itemType === 'service' ? 'service' : 'listing'
  const { rows } = await pool.query(
    `SELECT 1 FROM wishlists WHERE user_id=$1 AND item_type=$2 AND item_id=$3`,
    [userId, type, itemId]
  )
  if (rows.length) {
    await removeFromWishlist(userId, type, itemId)
    return false
  }
  await addToWishlist(userId, type, itemId)
  return true
}

/** Just the saved ids, so a client can mark hearts across a list cheaply. */
export async function getWishlistIds(userId: string): Promise<{ listingIds: string[]; serviceIds: string[] }> {
  if (!isUuid(userId)) return { listingIds: [], serviceIds: [] }
  const { rows } = await pool.query(
    `SELECT item_type, item_id FROM wishlists WHERE user_id = $1`,
    [userId]
  )
  return {
    listingIds: rows.filter((r) => r.item_type === 'listing').map((r) => r.item_id),
    serviceIds: rows.filter((r) => r.item_type === 'service').map((r) => r.item_id),
  }
}

/** Full saved listings + services (newest-saved first), for the wishlist screen. */
export async function getWishlist(userId: string): Promise<{ listings: Listing[]; services: Service[] }> {
  if (!isUuid(userId)) return { listings: [], services: [] }
  const listings = await pool.query(
    `SELECT ${LISTING_COLS} FROM listings l
       JOIN wishlists w ON w.item_id = l.id AND w.item_type = 'listing'
      WHERE w.user_id = $1 AND l.is_published = true
      ORDER BY w.created_at DESC`,
    [userId]
  )
  const services = await pool.query(
    `SELECT ${SERVICE_COLS} FROM ${SERVICE_FROM}
       JOIN wishlists w ON w.item_id = s.id AND w.item_type = 'service'
      WHERE w.user_id = $1 AND s.is_published = true
      ORDER BY w.created_at DESC`,
    [userId]
  )
  return { listings: listings.rows as Listing[], services: services.rows as Service[] }
}
