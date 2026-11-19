// The /ops listing photo viewer — turning a listing's `listing_images` rows into
// the ordered gallery an operator pages through.
//
// The /ops listings list carries ONE cover photo per row (plus `image_count`), so
// a reviewer approving a listing could not see the other nine photos the host
// uploaded. The full gallery is fetched on demand, one listing at a time, from
// GET /api/local/admin/listings/:id/photos — the list stays cheap even for rows
// whose photos were never backfilled to Blob and still hold inline data URLs.
//
// Both url shapes are legal (see listing-image-core.ts): an https:// Blob URL and
// a `data:image/...;base64,` URL. Anything else — empty, whitespace, a stray
// `javascript:` — is dropped rather than handed to an <img>.
//
// No runtime imports, so `node --test` can import this file directly.

export interface ListingImageRow {
  id?: string | null
  url: string | null | undefined
  order?: number | string | null
}

export interface AdminListingPhoto {
  id: string | null
  url: string
  /** 'hosted' = an https URL (Blob or pasted); 'inline' = a base64 data URL. */
  kind: 'hosted' | 'inline'
  /** 0-based position after sorting — what the viewer shows as "n of N". */
  position: number
}

const HTTP_URL_RE = /^https?:\/\/\S+$/i
const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+\s*;\s*base64\s*,/i

/** Which shape a stored url is, or null if it must not reach an <img>. */
export function classifyPhotoUrl(url: unknown): 'hosted' | 'inline' | null {
  if (typeof url !== 'string') return null
  const u = url.trim()
  if (!u) return null
  if (HTTP_URL_RE.test(u)) return 'hosted'
  if (IMAGE_DATA_URL_RE.test(u)) return 'inline'
  return null
}

function orderOf(row: ListingImageRow): number {
  // Number(null) and Number('') are 0 — a missing order must sort LAST, not first.
  if (row.order === null || row.order === undefined || row.order === '') return Number.POSITIVE_INFINITY
  const n = typeof row.order === 'number' ? row.order : Number(row.order)
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

/**
 * Sort by the host's `order` (rows with no order go last, ties keep insertion
 * order), drop unusable urls and exact duplicates, and number what is left.
 */
export function toAdminListingPhotos(rows: readonly ListingImageRow[] | null | undefined): AdminListingPhoto[] {
  if (!Array.isArray(rows)) return []
  const sorted = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => orderOf(a.row) - orderOf(b.row) || a.i - b.i)

  const seen = new Set<string>()
  const out: AdminListingPhoto[] = []
  for (const { row } of sorted) {
    const kind = classifyPhotoUrl(row.url)
    if (!kind) continue
    const url = String(row.url).trim()
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ id: row.id ? String(row.id) : null, url, kind, position: out.length })
  }
  return out
}
