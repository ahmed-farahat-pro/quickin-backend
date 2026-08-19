// Proof-of-ownership documents — what a host may attach to a listing.
//
// A title deed, a utility bill or a syndicate letter reaches a host as a photo
// OR as a PDF (registries, developers and utilities all issue PDFs), so this
// accepts three shapes: an image data URL, an `application/pdf` data URL, or an
// http(s) link. It was image-only until 2026-08-19, which left a host holding a
// PDF deed with no option but to photograph it off their screen — and a screen
// photo of a deed is exactly the document /ops keeps rejecting as illegible.
//
// A PDF is stored as it was uploaded. Unlike a photo there is nothing to
// downscale in the browser, so OWNERSHIP_DOC_MAX_CHARS is a limit hosts actually
// meet: 3.5M chars of data URL is roughly a 2.5 MB file once base64 has added
// its third. The uploader checks the same cap before the request goes out so the
// host is told which file is too big, not that "saving failed".
//
// Word documents are deliberately NOT accepted. /ops streams these bytes into an
// operator's browser (see document-core.ts) and a .docx cannot be displayed
// there — an unreviewable document is worse than a refused upload.
//
// No runtime imports, so `node --test` can import this file directly — see
// CLAUDE.md → "Standing requirement — docs and tests". db.ts imports the core,
// never the reverse.
//
// KEEP IN SYNC — quickin-backend and quickin-frontend each hold a copy and both
// write the same Neon rows. scripts/check-ownership-doc-core-parity.mjs fails if
// they drift, so edit one copy and paste it over the other verbatim.

/** Cap on an inline proof-of-ownership document (~3.5M chars of base64). */
export const OWNERSHIP_DOC_MAX_CHARS = 3_500_000

/** The `accept` attribute for every ownership-document file input, web-wide. */
export const OWNERSHIP_DOC_ACCEPT = 'image/*,application/pdf'

/**
 * Base64 of `%PDF-`, the five bytes every PDF opens with.
 *
 * The mime in a data URL is whatever the uploader wrote there, and a browser
 * hands us `application/octet-stream` for a .pdf often enough that trusting the
 * label alone would refuse real documents and admit fake ones. The payload's
 * first bytes are the thing that cannot lie, so they decide.
 */
const PDF_BASE64_MAGIC = 'JVBERi0'

const PDF_DATA_URL_RE = /^data:application\/pdf\s*;\s*base64\s*,\s*([\s\S]*)$/i
const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+\s*;\s*base64\s*,/i
const HTTP_URL_RE = /^https?:\/\/\S+$/i

/** SVG is an image by mime and a script host in practice, so /ops refuses to
 *  render it (see ALLOWED_DOCUMENT_MIME). Refusing it here too means a host is
 *  told at upload time instead of storing a document no operator can open. */
const SVG_DATA_URL_RE = /^data:image\/svg/i

/** True for a `data:application/pdf;base64,…` URL whose bytes really are a PDF. */
export function isPdfDataUrl(value: unknown): boolean {
  const m = PDF_DATA_URL_RE.exec(String(value ?? '').trim())
  return m !== null && m[1].replace(/\s+/g, '').startsWith(PDF_BASE64_MAGIC)
}

/** True for a value we would store in `listings.ownership_doc` (size aside). */
export function isOwnershipDocSrc(value: unknown): boolean {
  const doc = String(value ?? '').trim()
  if (SVG_DATA_URL_RE.test(doc)) return false
  return IMAGE_DATA_URL_RE.test(doc) || HTTP_URL_RE.test(doc) || isPdfDataUrl(doc)
}

/** What is wrong with a submitted document, or null when nothing is. */
export type OwnershipDocProblem = 'missing' | 'unsupported' | 'too_large'

/**
 * Validate a document a host attached. Returns the problem rather than throwing
 * so each repo can raise its own error type (ListingInputError on the mobile
 * API, a plain Error on the web) while both answer with the same sentence.
 */
export function checkOwnershipDoc(value: unknown): OwnershipDocProblem | null {
  const doc = String(value ?? '').trim()
  if (!doc) return 'missing'
  if (!isOwnershipDocSrc(doc)) return 'unsupported'
  // Checked last: a 4 MB JPEG should be told it is too large, not "unsupported".
  if (doc.length > OWNERSHIP_DOC_MAX_CHARS) return 'too_large'
  return null
}

/** The sentence shown to the host. `missing` and `unsupported` share one: from
 *  the form's side "nothing attached" and "that file isn't a document we take"
 *  have the same fix, and the routes match this text to answer 400. */
export function ownershipDocProblemMessage(problem: OwnershipDocProblem): string {
  return problem === 'too_large'
    ? 'That file is too large'
    : 'Please attach a photo or PDF of the document'
}
