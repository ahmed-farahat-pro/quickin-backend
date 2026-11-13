// Guest identity in /ops — a guest's phone, ID number and every file they uploaded,
// gathered onto their profile (/ops/users/:id) and summarised on each booking row.
//
// Two rules shape everything here:
//
//  1. The phone and ID number leave the API MASKED. The full values come only from
//     POST /api/local/admin/users/:id/identity, which writes an `identity_revealed`
//     row to staff_audit_log first. Masking in the browser alone would be cosmetic:
//     the full number would still sit in the page payload of every operator who
//     merely opened the profile.
//  2. Files are listed, never inlined. Each entry names a (kind, id[, n]) that the
//     audited /api/local/admin/documents channel serves one view at a time, so an
//     image the operator never opens is never sent, and one they do open is logged.
//
// No runtime imports, so `node --test` can import this file directly — see
// README → Testing.

/** How many trailing characters stay visible. Enough to tell two numbers apart on
 *  a call ("the one ending 234?"), not enough to use either. */
export const MASK_VISIBLE_TAIL = 3

/**
 * `•••••••••••234` — the value's own length, all but the last few characters hidden.
 * Spaces, dashes and a leading `+` keep their places so a masked phone still reads
 * as a phone. Values too short to hide anything are masked entirely.
 */
export function maskTail(value: unknown, visible: number = MASK_VISIBLE_TAIL): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const significant = raw.replace(/[\s\-+().]/g, '').length
  // Showing 3 of 4 digits is showing the number.
  const keep = significant > visible * 2 ? visible : 0
  let seen = 0
  let out = ''
  for (let i = raw.length - 1; i >= 0; i--) {
    const ch = raw[i]
    if (/[\s\-+().]/.test(ch)) { out = ch + out; continue }
    out = (seen < keep ? ch : '•') + out
    seen++
  }
  return out
}

/** Where the ID number on file came from — shown beside it, because the two are
 *  not equally trustworthy. */
export type IdNumberSource = 'verification' | 'profile'

/**
 * The ID number to show for a guest.
 *
 * The latest ID verification wins: its number was typed alongside a photo of the
 * document, so a reviewer can check one against the other. `users.id_document` is
 * the older profile field — free text, never reviewed (see id-change-core) — and is
 * the fallback only when no verification carries a number.
 */
export function pickIdNumber(
  verificationIdNumber: unknown,
  profileIdDocument: unknown,
): { value: string; source: IdNumberSource } | null {
  const v = String(verificationIdNumber ?? '').trim()
  if (v) return { value: v, source: 'verification' }
  const p = String(profileIdDocument ?? '').trim()
  if (p) return { value: p, source: 'profile' }
  return null
}

/** Every file kind a guest profile lists. Each is a DOCUMENT_KINDS value in
 *  document-core.ts, which is what lets the audited channel serve it. */
export type GuestFileKind =
  | 'id_front' | 'id_back' | 'id_selfie'
  | 'id_change_front' | 'id_change_back'
  | 'payment_proof'
  | 'dispute_photo'

/** Which group a file is listed under on the profile. */
export type GuestFileGroup = 'identity' | 'id_change' | 'payment' | 'dispute'

export interface GuestFile {
  kind: GuestFileKind
  /** The row the document channel looks up — verification, request, proof or dispute. */
  id: string
  /** Position in a dispute's photo list. Only dispute photos have one. */
  n?: number
  group: GuestFileGroup
  label: string
  /** The status of the thing the file belongs to, e.g. the verification's. */
  status: string | null
  /** A reservation code or the requested ID number's context — whatever tells two
   *  similar files apart. Never the ID number itself (that would bypass the mask). */
  context: string | null
  submitted_at: string | null
}

/** The rows `listGuestFiles` reads. Flags rather than bytes: whether a column is
 *  filled is all a listing needs. */
export interface GuestFileRows {
  verifications: Array<{
    id: string; status: string | null; doc_type: string | null; submitted_at: string | null
    has_front: boolean; has_back: boolean; has_selfie: boolean
  }>
  idChanges: Array<{
    id: string; status: string | null; doc_type: string | null; submitted_at: string | null
    has_front: boolean; has_back: boolean
  }>
  paymentProofs: Array<{
    id: string; status: string | null; method: string | null
    reservation_code: string | null; submitted_at: string | null
  }>
  disputes: Array<{
    id: string; status: string | null; category: string | null
    reservation_code: string | null; created_at: string | null; photo_count: number
  }>
}

const DOC_TYPE_LABEL: Record<string, string> = {
  national_id: 'National ID',
  passport: 'Passport',
  residence_permit: 'Residence permit',
}

/** "National ID", "Passport"… — or a generic "ID" for an unknown or missing type. */
export function docTypeLabel(docType: unknown): string {
  return DOC_TYPE_LABEL[String(docType ?? '')] ?? 'ID'
}

/** "Instapay", "Bank transfer"… for a payment proof's method. */
function methodLabel(method: unknown): string {
  const m = String(method ?? '').trim()
  if (!m) return 'Payment'
  if (m === 'bank_transfer') return 'Bank transfer'
  if (m === 'instapay') return 'Instapay'
  return m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, ' ')
}

/**
 * Flatten a guest's uploads into one ordered list: identity first (what an operator
 * opening a profile is most often here for), then ID-change evidence, then payment
 * screenshots, then dispute photos. Within a group the rows keep the order they
 * were read in, which the queries make newest-first.
 */
export function listGuestFiles(rows: GuestFileRows): GuestFile[] {
  const out: GuestFile[] = []
  for (const v of rows.verifications) {
    const doc = docTypeLabel(v.doc_type)
    const base = { id: v.id, group: 'identity' as const, status: v.status, context: null, submitted_at: v.submitted_at }
    if (v.has_front) out.push({ ...base, kind: 'id_front', label: `${doc} — front` })
    if (v.has_back) out.push({ ...base, kind: 'id_back', label: `${doc} — back` })
    if (v.has_selfie) out.push({ ...base, kind: 'id_selfie', label: 'Selfie' })
  }
  for (const r of rows.idChanges) {
    const doc = docTypeLabel(r.doc_type)
    const base = { id: r.id, group: 'id_change' as const, status: r.status, context: 'ID change request', submitted_at: r.submitted_at }
    if (r.has_front) out.push({ ...base, kind: 'id_change_front', label: `${doc} — front` })
    if (r.has_back) out.push({ ...base, kind: 'id_change_back', label: `${doc} — back` })
  }
  for (const p of rows.paymentProofs) {
    out.push({
      kind: 'payment_proof', id: p.id, group: 'payment', status: p.status,
      label: `${methodLabel(p.method)} screenshot`,
      context: p.reservation_code, submitted_at: p.submitted_at,
    })
  }
  for (const d of rows.disputes) {
    const count = Math.max(0, Math.floor(Number(d.photo_count) || 0))
    for (let n = 0; n < count; n++) {
      out.push({
        kind: 'dispute_photo', id: d.id, n, group: 'dispute', status: d.status,
        label: count > 1 ? `Dispute photo ${n + 1} of ${count}` : 'Dispute photo',
        context: d.reservation_code, submitted_at: d.created_at,
      })
    }
  }
  return out
}

/** Parse the `?n=` of a dispute photo request. Null for anything that is not a
 *  small non-negative integer — the route turns that into a 400. */
export function parsePhotoIndex(value: unknown): number | null {
  const raw = String(value ?? '').trim()
  if (!/^\d{1,3}$/.test(raw)) return null
  return Number(raw)
}
