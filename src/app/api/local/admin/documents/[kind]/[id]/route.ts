import { NextResponse } from 'next/server'
import { requireStaff, clientIpOf } from '@/lib/local/staff'
import { adminReadDocument, recordDocumentView } from '@/lib/local/db'
import {
  asDocumentUrl,
  auditTargetTypeFor,
  base64ByteLength,
  DocumentFormatError,
  documentFileExtension,
  isDocumentKind,
  owningModuleFor,
  parseDocumentDataUrl,
} from '@/lib/local/document-core'

// GET /api/local/admin/documents/:kind/:id
//   kind ∈ id_front | id_back | id_selfie | ownership
//   id   = the id_verifications row (ID kinds) or the listing (ownership)
//
// Serves ONE document's bytes, to ONE operator, ONE view at a time — and records it.
// Before this existed, the verification queue shipped every pending submission's
// three ID photos to anyone who opened the tab, and the listings queue shipped every
// pending ownership document, both with no record of who saw them.
//
// NOTE the two deliberate departures from every other admin route here:
//   1. No Access-Control-Allow-Origin. Every other admin route sets '*'; identity
//      documents must not be readable cross-origin. Don't "fix" this by copying the
//      CORS const from a neighbouring route.
//   2. The audit write is awaited and allowed to THROW (see recordDocumentView).
//      An unlogged view is the exact thing E4 exists to prevent, so it fails closed.
//
// A PDF (ownership documents only) is served the same way as an image. The
// operator's browser opens it in its own sandboxed viewer, so script inside a
// hostile PDF never runs against the /ops origin — which is why SVG stays
// refused and PDF does not. See ALLOWED_OWNERSHIP_MIME.
export const dynamic = 'force-dynamic'

/** Not shared with the other admin routes on purpose — see note 1 above. */
const HEADERS = {
  'Cache-Control': 'no-store, private, max-age=0, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

export async function GET(req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await ctx.params
  if (!isDocumentKind(kind)) {
    return NextResponse.json({ error: 'Unknown document kind' }, { status: 400, headers: HEADERS })
  }

  // `documents` is a capability, not a bypass: it lets an operator open a document
  // they could already reach, it does not hand them a queue they were never granted.
  // So both gates must pass.
  const gate = await requireStaff(req, 'documents')
  if ('error' in gate) return gate.error
  const owning = await requireStaff(req, owningModuleFor(kind))
  if ('error' in owning) return owning.error

  try {
    const doc = await adminReadDocument(kind, id)
    // Missing row, missing document, and bad id all look identical from outside.
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404, headers: HEADERS })

    const targetType = auditTargetTypeFor(kind)
    const targetId = targetType === 'user' ? doc.subjectId : id

    // A stored https:// link (normalizeOwnershipDoc allows one) is handed back as
    // JSON rather than redirected — a 302 would leak the operator's referrer to a
    // third-party host and skip this audit on every refresh.
    const url = asDocumentUrl(doc.value)
    if (url) {
      await recordDocumentView({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        targetType, targetId,
        detail: { kind, document_id: id, form: 'url' },
        ip: clientIpOf(req),
      })
      return NextResponse.json({ url }, { headers: HEADERS })
    }

    // The kind decides the allowlist: an ownership document may also be a PDF
    // (a deed is issued as one), while the ID kinds stay image-only.
    const { mime, base64 } = parseDocumentDataUrl(doc.value, kind)

    // Logged BEFORE the bytes are handed over — the row means "this was about to
    // leave", the same ordering analytics/export uses.
    await recordDocumentView({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      targetType, targetId,
      detail: { kind, document_id: id, mime, bytes: base64ByteLength(base64) },
      ip: clientIpOf(req),
    })

    return new Response(new Uint8Array(Buffer.from(base64, 'base64')), {
      headers: { ...HEADERS, 'Content-Type': mime, 'Content-Disposition': `inline; filename="${kind}-${id.slice(0, 8)}.${documentFileExtension(mime)}"` },
    })
  } catch (err) {
    // A document stored in a shape we refuse to render (an SVG, junk base64) is a
    // 415, not a 500 — it says "this file is unusable", not "the server broke".
    if (err instanceof DocumentFormatError) {
      return NextResponse.json({ error: err.message }, { status: 415, headers: HEADERS })
    }
    console.error('admin document GET:', err)
    return NextResponse.json({ error: 'Could not open the document' }, { status: 500, headers: HEADERS })
  }
}
