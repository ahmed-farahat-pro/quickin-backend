// Where a listing photo's bytes live — and how a stored `listing_images.url` is
// classified when they could be in either place.
//
// Photos used to be stored as `data:image/jpeg;base64,…` directly in
// `listing_images.url`. That is why GET /api/local/listings answered 7.3 MB for
// TWO listings: 99.97% of the response was twenty full-resolution JPEGs inlined
// into the JSON, and `Cache-Control: no-store` meant every visit paid for them
// again. Base64 also inflates the bytes by a third, and — being a payload rather
// than a URL — it cannot be cached by a browser, a CDN or an image loader, so
// the cost repeats on every single read.
//
// Photos are now uploaded to Vercel Blob and the row stores the https:// URL it
// returns. The JSON carries ~100 bytes per photo instead of ~370 KB, and the
// bytes are served from the CDN as immutable, cacheable objects.
//
// BOTH SHAPES STAY LEGAL. Rows written before the backfill still hold data URLs,
// and a deployment without BLOB_READ_WRITE_TOKEN keeps writing them (see
// blob-store.ts), so nothing here may assume the migration has happened. This is
// also why the API response shape did not change: iOS reads the gallery straight
// off the LIST payload — ListingDetailView holds `let listing: Listing` and never
// refetches it — so trimming the list to a cover photo would have left a tapped
// card showing one photo instead of ten. Full URLs are cheap; trimming was only
// ever a workaround for base64 bloat.
//
// No runtime imports, so `node --test` can import this file directly — see
// CLAUDE.md → "Standing requirement — docs and tests". db.ts imports the core,
// never the reverse.

/** A `data:image/<type>;base64,<payload>` URL, captured as (mime subtype, payload). */
const IMAGE_DATA_URL_RE = /^data:image\/([a-z0-9.+-]+)\s*;\s*base64\s*,\s*([\s\S]*)$/i

/** An http(s) URL — what Blob hands back, and what a host may paste directly. */
const HTTP_URL_RE = /^https?:\/\/\S+$/i

/** Blob object keys are grouped per listing so a store browser is navigable and
 *  a listing's photos can be located without a database round-trip. */
const BLOB_PREFIX = 'listings'

/** Mime subtype → file extension. The extension is cosmetic (the object's
 *  `contentType` is what a browser honours), but a URL ending in `.jpg` is what
 *  makes a Blob store browsable and a stray link recognisable. */
const EXTENSION_BY_SUBTYPE: Record<string, string> = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  heic: 'heic',
  heif: 'heif',
}

/** A photo's bytes, pulled apart from the data URL that carried them. */
export interface ParsedImageDataUrl {
  /** Full mime type, e.g. `image/jpeg` — becomes the blob's `contentType`. */
  mime: string
  /** The base64 payload, whitespace stripped, ready for `Buffer.from(…, 'base64')`. */
  base64: string
  /** File extension for the blob key, without the dot. */
  ext: string
  /** Decoded size in bytes — what the photo will actually occupy in Blob. */
  byteLength: number
}

/**
 * Decoded byte count of a base64 payload, without decoding it.
 *
 * The backfill reports megabytes moved and the uploader enforces a size budget;
 * both would otherwise have to materialise the buffer just to measure it.
 */
export function base64ByteLength(base64: unknown): number {
  const clean = String(base64 ?? '').replace(/\s+/g, '')
  if (!clean) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

/**
 * Pull a `data:image/…;base64,…` URL apart, or null when `value` is not one.
 *
 * Null is the answer for an http(s) URL too — that is not a failure, it is a
 * photo whose bytes already live somewhere addressable, which callers store
 * unchanged.
 */
export function parseImageDataUrl(value: unknown): ParsedImageDataUrl | null {
  const m = IMAGE_DATA_URL_RE.exec(String(value ?? '').trim())
  if (!m) return null
  const subtype = m[1].toLowerCase()
  const base64 = m[2].replace(/\s+/g, '')
  if (!base64) return null
  return {
    mime: `image/${subtype}`,
    base64,
    ext: EXTENSION_BY_SUBTYPE[subtype] ?? 'bin',
    byteLength: base64ByteLength(base64),
  }
}

/** True when this value is an inline `data:image/…;base64,…` photo. */
export function isImageDataUrl(value: unknown): boolean {
  return parseImageDataUrl(value) !== null
}

/** True when this value is an http(s) URL — a photo already served from
 *  somewhere, whether Vercel Blob or a link a host pasted. */
export function isHostedImageUrl(value: unknown): boolean {
  return HTTP_URL_RE.test(String(value ?? '').trim())
}

/**
 * The blob key a listing's photo is stored under, e.g.
 * `listings/<uuid>/photo.jpg`.
 *
 * This is a PREFIX, not the final key: uploads pass `addRandomSuffix: true`, so
 * Blob appends its own token and every upload lands on a URL nothing has served
 * before. That is deliberate. The objects are served immutable and cached
 * forever, so reusing a key for replaced bytes would leave the CDN handing out
 * the old photo — a host would swap a picture and watch nothing change.
 */
export function listingImageBlobPath(listingId: string, ext: string): string {
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : 'bin'
  return `${BLOB_PREFIX}/${listingId}/photo.${safeExt}`
}
