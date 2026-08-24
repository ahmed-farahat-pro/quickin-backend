// backfill-listing-images-to-blob.mjs — move inlined listing photos into Vercel Blob
//
// Every `listing_images` row written before the Blob migration holds the photo
// itself: a `data:image/jpeg;base64,…` string of 250–640 KB. That is why
// GET /api/local/listings answered 7.3 MB for two listings. This script uploads
// each of those payloads to Blob once and rewrites the row to the returned URL.
//
// Usage:
//   DATABASE_URL='<url>' BLOB_READ_WRITE_TOKEN='<token>' node scripts/backfill-listing-images-to-blob.mjs
//   …add --dry-run to report what WOULD move without uploading or writing.
//
// Safe to re-run. Rows already holding an http(s) URL are skipped, so a run that
// dies halfway resumes where it stopped, and a second run is a no-op.
//
// Deliberately NOT destructive: the original base64 is only overwritten after
// its upload has returned a URL, one row at a time. A failed upload leaves that
// row inline and the photo keeps rendering — the listing degrades to slow, never
// to broken. Nothing here deletes a blob, so a bad run costs storage, not photos.
import pg from 'pg'
import { put } from '@vercel/blob'
import { parseImageDataUrl, listingImageBlobPath } from '../src/lib/local/listing-image-core.ts'

const DRY_RUN = process.argv.includes('--dry-run')
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL is required')
if (!process.env.BLOB_READ_WRITE_TOKEN && !DRY_RUN) {
  throw new Error('BLOB_READ_WRITE_TOKEN is required (or pass --dry-run)')
}

const isLocal = DATABASE_URL.includes('127.0.0.1') || DATABASE_URL.includes('localhost')
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 5,
  ssl: isLocal ? false : { rejectUnauthorized: false },
})

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

async function main() {
  log(DRY_RUN ? 'DRY RUN — nothing will be uploaded or written' : 'Backfilling listing photos into Vercel Blob')

  // Ordered so a partial run leaves each listing's photos contiguous, which
  // makes an interrupted run easy to read in the log.
  const { rows } = await pool.query(
    `SELECT id, listing_id, url, "order" FROM listing_images ORDER BY listing_id, "order"`,
  )

  const inline = rows.filter((r) => parseImageDataUrl(r.url) !== null)
  const already = rows.length - inline.length
  log(`${rows.length} photo rows: ${inline.length} inline, ${already} already hosted`)
  if (!inline.length) {
    log('Nothing to do.')
    return
  }

  let moved = 0
  let failed = 0
  let bytes = 0

  for (const row of inline) {
    const parsed = parseImageDataUrl(row.url)
    const label = `${row.listing_id} #${row.order} (${mb(parsed.byteLength)})`
    if (DRY_RUN) {
      log(`would move ${label}`)
      bytes += parsed.byteLength
      moved++
      continue
    }
    try {
      const { url } = await put(
        listingImageBlobPath(row.listing_id, parsed.ext),
        Buffer.from(parsed.base64, 'base64'),
        { access: 'public', contentType: parsed.mime, addRandomSuffix: true },
      )
      // Guarded on the url still being the one we read, so a host who replaced
      // this photo mid-run does not have their new picture overwritten by the
      // old one we happened to be holding.
      const { rowCount } = await pool.query(
        `UPDATE listing_images SET url = $2 WHERE id = $1 AND url = $3`,
        [row.id, url, row.url],
      )
      if (rowCount) {
        moved++
        bytes += parsed.byteLength
        log(`moved ${label} → ${url}`)
      } else {
        log(`skipped ${label} — the row changed while it was uploading`)
      }
    } catch (err) {
      failed++
      // Left inline on purpose: the photo still renders, just slowly.
      log(`FAILED ${label} — left inline: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // The two modes MUST report differently. They did not until 2026-08-24, and a
  // dry run announcing "27 moved" reads exactly like a finished migration —
  // which is how one got mistaken for the real thing, with an empty Blob store
  // and every row still inline as the only evidence anything was wrong.
  if (DRY_RUN) {
    log(`Dry run finished — NOTHING was uploaded or written.`)
    log(`${moved} photo(s) WOULD move (${mb(bytes)}), ${already} already hosted.`)
    log('Re-run without --dry-run to actually move them.')
    return
  }

  log(`Done. ${moved} moved (${mb(bytes)} out of the database), ${failed} failed, ${already} already hosted.`)
  if (failed) log('Re-run to retry the failures — moved rows are skipped automatically.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
