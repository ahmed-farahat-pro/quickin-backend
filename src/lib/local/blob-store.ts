// Uploading listing photos to Vercel Blob.
//
// The rule this module exists to enforce: a photo's BYTES never travel through
// an API response again. A host uploads a `data:image/…;base64,…`, we put the
// decoded bytes in Blob once, and from then on every read carries a ~100-byte
// URL that a browser, a CDN and an image loader can all cache.
//
// DEGRADES INSTEAD OF FAILING. With no BLOB_READ_WRITE_TOKEN configured, and if
// an upload errors, `storeListingPhoto` returns the original data URL and the
// row is written exactly as it was before. A missing Blob store, an expired
// token or a Blob outage therefore costs a slow response — the behaviour that
// shipped for months — and never a host who cannot add a photo to their listing.
// This is also what lets the code deploy before the store exists.
//
// Pure logic lives in listing-image-core.ts (parsing, sizing, key naming) so it
// can be unit-tested; everything here does I/O and cannot be.

import {
  listingImageBlobPath,
  parseImageDataUrl,
  type ParsedImageDataUrl,
} from './listing-image-core'

/** True when this deployment can reach a Blob store. Vercel injects this env var
 *  when a store is linked to the project; locally it comes from `vercel env pull`. */
export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

/**
 * Upload one photo's bytes and return the URL to store in `listing_images.url`.
 *
 * Returns `src` unchanged when it is already an http(s) URL (nothing to move),
 * when Blob is not configured, or when the upload fails — see the note above on
 * degrading rather than failing.
 */
export async function storeListingPhoto(listingId: string, src: string): Promise<string> {
  const parsed = parseImageDataUrl(src)
  if (!parsed) return src
  if (!blobConfigured()) return src
  try {
    return await putListingPhoto(listingId, parsed)
  } catch (err) {
    // Deliberately not rethrown: the caller is a host saving a listing, and a
    // storage problem is ours, not theirs. The data URL still renders.
    console.error(`Blob upload failed for listing ${listingId}, keeping the inline photo:`, err)
    return src
  }
}

/**
 * The same for a whole photo set, uploaded concurrently.
 *
 * Order is preserved — it is the listing's display order, and index 0 is the
 * cover. Photos already stored as URLs pass straight through, so re-saving a
 * listing does not re-upload what is already in Blob.
 */
export async function storeListingPhotos(listingId: string, srcs: string[]): Promise<string[]> {
  return Promise.all(srcs.map((src) => storeListingPhoto(listingId, src)))
}

/** The upload itself. Separated so the error handling above reads in one screen. */
async function putListingPhoto(listingId: string, parsed: ParsedImageDataUrl): Promise<string> {
  // Imported lazily so this module — and therefore db.ts — still loads in an
  // environment where the package or the token is absent.
  const { put } = await import('@vercel/blob')
  const { url } = await put(
    listingImageBlobPath(listingId, parsed.ext),
    Buffer.from(parsed.base64, 'base64'),
    {
      // Listing photos are shown to signed-out guests browsing /explore, so the
      // browser must fetch them straight from the store. Private blobs would
      // have to be streamed back through a function on every view — the docs
      // are explicit that this is both slow and expensive.
      access: 'public',
      contentType: parsed.mime,
      // Never reuse a key: objects are cached immutably, so overwriting one
      // would leave the CDN serving the photo a host just replaced.
      addRandomSuffix: true,
    },
  )
  return url
}
