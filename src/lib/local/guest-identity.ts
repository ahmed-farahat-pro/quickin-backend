// Guest identity for /ops — the queries behind the profile's "Identity & documents"
// panel and its audited Reveal. The rules (masking, which number wins, how files are
// listed) live in guest-identity-core.ts; this file only reads.
import { pool } from './pool'
import {
  docTypeLabel,
  listGuestFiles,
  maskTail,
  pickIdNumber,
  type GuestFile,
  type GuestFileRows,
  type IdNumberSource,
} from './guest-identity-core'

const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`

/** What the profile renders before anyone presses Reveal. Nothing here is usable
 *  on its own: the phone and number are masked, the files are references. */
export interface GuestIdentityView {
  phone_masked: string | null
  id_number_masked: string | null
  id_number_source: IdNumberSource | null
  doc_type: string | null
  doc_type_label: string | null
  verification_status: string
  /** The reviewer's note on the latest verification — the reason, on a rejection. */
  verification_notes: string | null
  /** 'signup' | 'manual' | 'host_application'… — where the latest verification came from. */
  verification_source: string | null
  verification_submitted_at: string | null
  files: GuestFile[]
}

/** The full values, for the audited Reveal only. */
export interface GuestIdentitySecrets {
  phone: string | null
  id_number: string | null
  id_number_source: IdNumberSource | null
  doc_type: string | null
}

interface Core {
  phone: string | null
  id_document: string | null
  verification_status: string | null
  latest: { id_number: string | null; doc_type: string | null; notes: string | null; source: string | null; submitted_at: string | null } | null
}

async function readCore(userId: string): Promise<Core | null> {
  const { rows } = await pool.query(
    `SELECT u.phone, u.id_document, COALESCE(u.verification_status, 'unverified') AS verification_status
       FROM users u WHERE u.id = $1`,
    [userId],
  )
  const u = rows[0] as Omit<Core, 'latest'> | undefined
  if (!u) return null
  const { rows: v } = await pool.query(
    `SELECT id_number, doc_type, notes, source, ${TS('submitted_at')} AS submitted_at
       FROM id_verifications WHERE user_id = $1
      ORDER BY submitted_at DESC LIMIT 1`,
    [userId],
  )
  return { ...u, latest: (v[0] as Core['latest']) ?? null }
}

/** A table a migration may not have reached yet reads as empty rather than taking
 *  the whole profile down — see [pending migrations] in the README. */
async function rowsOrEmpty<T>(sql: string, params: unknown[]): Promise<T[]> {
  try {
    return (await pool.query(sql, params)).rows as T[]
  } catch (err) {
    if ((err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '42703') return []
    throw err
  }
}

/** The masked view for /ops/users/:id. Null for an unknown or non-uuid id. */
export async function adminGetGuestIdentity(userId: string): Promise<GuestIdentityView | null> {
  if (!isUuid(userId)) return null
  const core = await readCore(userId)
  if (!core) return null

  const [verifications, idChanges, paymentProofs, disputes] = await Promise.all([
    rowsOrEmpty<GuestFileRows['verifications'][number]>(
      `SELECT id, status, doc_type, ${TS('submitted_at')} AS submitted_at,
              (image_data        IS NOT NULL AND image_data        <> '') AS has_front,
              (back_image_data   IS NOT NULL AND back_image_data   <> '') AS has_back,
              (selfie_image_data IS NOT NULL AND selfie_image_data <> '') AS has_selfie
         FROM id_verifications WHERE user_id = $1
        ORDER BY submitted_at DESC LIMIT 20`,
      [userId],
    ),
    rowsOrEmpty<GuestFileRows['idChanges'][number]>(
      `SELECT id, status, doc_type, ${TS('created_at')} AS submitted_at,
              (image_data      IS NOT NULL AND image_data      <> '') AS has_front,
              (back_image_data IS NOT NULL AND back_image_data <> '') AS has_back
         FROM id_change_requests WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [userId],
    ),
    rowsOrEmpty<GuestFileRows['paymentProofs'][number]>(
      `SELECT pp.id, pp.status, pp.method, NULLIF(b.reservation_code, '') AS reservation_code,
              ${TS('pp.submitted_at')} AS submitted_at
         FROM payment_proofs pp JOIN bookings b ON b.id = pp.booking_id
        WHERE b.user_id = $1
        ORDER BY pp.submitted_at DESC LIMIT 50`,
      [userId],
    ),
    rowsOrEmpty<GuestFileRows['disputes'][number]>(
      `SELECT d.id, d.status, d.category, NULLIF(b.reservation_code, '') AS reservation_code,
              ${TS('d.created_at')} AS created_at,
              COALESCE(array_length(d.photos, 1), 0)::int AS photo_count
         FROM disputes d LEFT JOIN bookings b ON b.id = d.booking_id
        WHERE d.guest_id = $1
        ORDER BY d.created_at DESC LIMIT 50`,
      [userId],
    ),
  ])

  const picked = pickIdNumber(core.latest?.id_number, core.id_document)
  const docType = core.latest?.doc_type ?? null
  return {
    phone_masked: maskTail(core.phone),
    id_number_masked: picked ? maskTail(picked.value) : null,
    id_number_source: picked?.source ?? null,
    doc_type: docType,
    doc_type_label: docType ? docTypeLabel(docType) : null,
    verification_status: core.verification_status ?? 'unverified',
    verification_notes: core.latest?.notes ?? null,
    verification_source: core.latest?.source ?? null,
    verification_submitted_at: core.latest?.submitted_at ?? null,
    files: listGuestFiles({ verifications, idChanges, paymentProofs, disputes }),
  }
}

/** The unmasked phone and ID number. Callers MUST audit before returning these. */
export async function adminRevealGuestIdentity(userId: string): Promise<GuestIdentitySecrets | null> {
  if (!isUuid(userId)) return null
  const core = await readCore(userId)
  if (!core) return null
  const picked = pickIdNumber(core.latest?.id_number, core.id_document)
  return {
    phone: core.phone?.trim() || null,
    id_number: picked?.value ?? null,
    id_number_source: picked?.source ?? null,
    doc_type: core.latest?.doc_type ?? null,
  }
}

/** The audit row for a Reveal. Unlike logStaffAction this THROWS on failure: the
 *  route awaits it before answering, so an unlogged reveal never happens — the same
 *  fail-closed rule as recordDocumentView. Records which fields were shown, never
 *  the values. */
export async function recordIdentityReveal(entry: {
  staffId: string | null
  staffEmail: string | null
  userId: string
  detail: unknown
  ip: string | null
}): Promise<void> {
  await pool.query(
    `INSERT INTO staff_audit_log (staff_id, staff_email, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, 'identity_revealed', 'user', $3, $4::jsonb, $5)`,
    [entry.staffId, entry.staffEmail, entry.userId, JSON.stringify(entry.detail), entry.ip],
  )
}
