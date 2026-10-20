import { pool } from './pool'
import { LISTING_COLS, type Listing } from './db'
import { emptyServicesPart, type WishItemType } from './wishlist-core'

// Wishlist: a signed-in user saves listings. One row per (user, item_type, item_id).
// getWishlist returns the full saved objects so the client can render cards directly.
//
// Services were removed 2026-10-20: rows with item_type = 'service' stay in the
// table untouched but are never read, and none can be added (see wishlist-core.ts).
// The responses keep their `services` / `serviceIds` keys, always empty.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)
export type { WishItemType }

export async function addToWishlist(userId: string, _itemType: WishItemType, itemId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(itemId)) return false
  await pool.query(
    `INSERT INTO wishlists (user_id, item_type, item_id) VALUES ($1,'listing',$2)
     ON CONFLICT (user_id, item_type, item_id) DO NOTHING`,
    [userId, itemId]
  )
  return true
}

export async function removeFromWishlist(userId: string, _itemType: WishItemType, itemId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(itemId)) return false
  await pool.query(
    `DELETE FROM wishlists WHERE user_id = $1 AND item_type = 'listing' AND item_id = $2`,
    [userId, itemId]
  )
  return true
}

/** Toggle: returns the new saved-state (true = now saved). */
export async function toggleWishlist(userId: string, itemType: WishItemType, itemId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(itemId)) return false
  const { rows } = await pool.query(
    `SELECT 1 FROM wishlists WHERE user_id=$1 AND item_type='listing' AND item_id=$2`,
    [userId, itemId]
  )
  if (rows.length) {
    await removeFromWishlist(userId, itemType, itemId)
    return false
  }
  await addToWishlist(userId, itemType, itemId)
  return true
}

/** Just the saved ids, so a client can mark hearts across a list cheaply.
 *  `serviceIds` is always empty — kept so old clients still decode the response. */
export async function getWishlistIds(userId: string): Promise<{ listingIds: string[]; serviceIds: never[] }> {
  const { serviceIds } = emptyServicesPart()
  if (!isUuid(userId)) return { listingIds: [], serviceIds }
  const { rows } = await pool.query(
    `SELECT item_id FROM wishlists WHERE user_id = $1 AND item_type = 'listing'`,
    [userId]
  )
  return { listingIds: rows.map((r) => r.item_id), serviceIds }
}

/** Full saved listings (newest-saved first), for the wishlist screen.
 *  `services` is always empty — kept so old clients still decode the response. */
export async function getWishlist(userId: string): Promise<{ listings: Listing[]; services: never[] }> {
  const { services } = emptyServicesPart()
  if (!isUuid(userId)) return { listings: [], services }
  const listings = await pool.query(
    `SELECT ${LISTING_COLS} FROM listings l
       JOIN wishlists w ON w.item_id = l.id AND w.item_type = 'listing'
      WHERE w.user_id = $1 AND l.is_published = true
      ORDER BY w.created_at DESC`,
    [userId]
  )
  return { listings: listings.rows as Listing[], services }
}
