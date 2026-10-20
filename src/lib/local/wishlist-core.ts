// Wishlist — the pure rules behind `/api/local/wishlist`.
//
// A wishlist used to hold listings AND services. Services were removed on
// 2026-10-20 (the `services` table is kept, dormant), so only listings can be
// saved now. Old app builds still send `item_type: 'service'`; that is refused
// with 410 rather than silently saved as a listing under a service's id. Every
// other value — including no value at all — means a listing, exactly as before.
//
// The GET response keeps its old shape (`services: []`, `serviceIds: []`) so an
// old client that reads those keys still decodes it.
//
// No runtime imports, so test/unit/wishlist-core.test.mjs can load it directly.
// wishlist.ts holds the SQL and imports this, never the reverse.

export type WishItemType = 'listing'

export type WishItemTypeResult =
  | { ok: true; type: WishItemType }
  | { ok: false; status: 410; error: string }

export const SERVICES_GONE_ERROR = 'Services have been removed'

/** Read the `item_type` a client sent. Only exactly `'service'` (what the old
 *  apps sent) is refused; anything else is a listing, as it always was. */
export function parseWishItemType(v: unknown): WishItemTypeResult {
  if (v === 'service') {
    return { ok: false, status: 410, error: SERVICES_GONE_ERROR }
  }
  return { ok: true, type: 'listing' }
}

/** The service half of the old response, always empty. */
export function emptyServicesPart(): { services: never[]; serviceIds: never[] } {
  return { services: [], serviceIds: [] }
}
