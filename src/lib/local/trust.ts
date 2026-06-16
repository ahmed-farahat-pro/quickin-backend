import { pool } from './pool'
import { createNotification } from './notifications'
import { sendPush } from './push'

// Trust & safety: identity verification, computed trust badges, and reports.
// Verification doc is a data-URL the user uploads (prototype — no real KYC).

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected'

export interface VerificationState {
  status: VerificationStatus
  verified_at: string | null
}

/** A user submits an ID image for verification → status becomes 'pending'. */
export async function submitVerification(userId: string, doc: string): Promise<VerificationState> {
  if (!isUuid(userId)) throw new Error('Invalid user')
  const d = String(doc ?? '').trim()
  if (!/^data:image\//i.test(d) && !/^https?:\/\//i.test(d)) {
    throw new Error('Please attach a photo of your ID')
  }
  if (d.length > 3_500_000) throw new Error('That image is too large')
  const { rows } = await pool.query(
    `UPDATE users SET verification_status = 'pending', verification_doc = $2
      WHERE id = $1
      RETURNING verification_status AS status, to_char(verified_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS verified_at`,
    [userId, d]
  )
  if (!rows[0]) throw new Error('User not found')
  return rows[0] as VerificationState
}

/** The signed-in user's own verification status. */
export async function getVerificationStatus(userId: string): Promise<VerificationState> {
  if (!isUuid(userId)) return { status: 'unverified', verified_at: null }
  const { rows } = await pool.query(
    `SELECT COALESCE(verification_status, 'unverified') AS status,
            to_char(verified_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS verified_at
       FROM users WHERE id = $1`,
    [userId]
  )
  return (rows[0] as VerificationState) ?? { status: 'unverified', verified_at: null }
}

/** Admin approves/rejects a pending verification; notifies the user. */
export async function setVerification(userId: string, approve: boolean): Promise<VerificationState | null> {
  if (!isUuid(userId)) return null
  const status: VerificationStatus = approve ? 'verified' : 'rejected'
  const { rows } = await pool.query(
    `UPDATE users SET verification_status = $2,
            verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE NULL END
      WHERE id = $1
      RETURNING verification_status AS status, to_char(verified_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS verified_at`,
    [userId, status]
  )
  if (!rows[0]) return null
  await createNotification(userId, {
    type: 'verification',
    title: approve ? 'You’re verified ✓' : 'Verification update',
    body: approve ? 'Your identity has been verified.' : 'We couldn’t verify your ID. Please resubmit a clearer photo.',
    link: '/account',
  })
  await sendPush(userId, {
    title: approve ? 'Identity verified ✓' : 'Verification update',
    body: approve ? 'Your QuickIn account is now verified.' : 'Please resubmit your ID.',
    link: '/account',
  })
  return rows[0] as VerificationState
}

/** Pending verifications for the admin queue (includes the submitted doc). */
export async function listPendingVerifications(): Promise<
  { id: string; full_name: string | null; email: string; verification_doc: string | null; role: string }[]
> {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, verification_doc, role
       FROM users WHERE verification_status = 'pending'
      ORDER BY id`
  )
  return rows
}

// ---- Badges -----------------------------------------------------------------

export interface UserBadges {
  verified: boolean
  superhost: boolean
  newHost: boolean
  isHost: boolean
  completedStays: number
  reviewCount: number
  hostRating: number
  memberSince: string | null
}

/** Computed trust signals for a user (verified, superhost, etc.). Superhost =
 *  a host with ≥3 completed stays across their listings AND ≥4.8 avg rating. */
export async function getUserBadges(userId: string): Promise<UserBadges> {
  if (!isUuid(userId)) {
    return { verified: false, superhost: false, newHost: false, isHost: false, completedStays: 0, reviewCount: 0, hostRating: 0, memberSince: null }
  }
  const { rows } = await pool.query(
    `SELECT
        (u.verification_status = 'verified') AS verified,
        to_char(u.created_at, 'YYYY-MM-DD') AS member_since,
        (SELECT count(*) FROM listings l WHERE l.host_id = u.id)::int AS listing_count,
        (SELECT count(*) FROM bookings b JOIN listings l ON l.id = b.listing_id
          WHERE l.host_id = u.id AND b.status IN ('completed','confirmed'))::int AS completed_stays,
        (SELECT count(*) FROM reviews r JOIN listings l ON l.id = r.listing_id
          WHERE l.host_id = u.id)::int AS review_count,
        COALESCE((SELECT round(avg(r.rating)::numeric, 2) FROM reviews r JOIN listings l ON l.id = r.listing_id
          WHERE l.host_id = u.id), 0)::float8 AS host_rating
       FROM users u WHERE u.id = $1`,
    [userId]
  )
  const r = rows[0]
  if (!r) return { verified: false, superhost: false, newHost: false, isHost: false, completedStays: 0, reviewCount: 0, hostRating: 0, memberSince: null }
  const isHost = Number(r.listing_count) > 0
  const completedStays = Number(r.completed_stays)
  const hostRating = Number(r.host_rating)
  const superhost = isHost && completedStays >= 3 && hostRating >= 4.8
  return {
    verified: Boolean(r.verified),
    superhost,
    newHost: isHost && !superhost && completedStays < 3,
    isHost,
    completedStays,
    reviewCount: Number(r.review_count),
    hostRating,
    memberSince: r.member_since,
  }
}

export interface PublicProfile {
  id: string
  full_name: string | null
  avatar_url: string | null
  bio: string | null
  verification_status: VerificationStatus
  badges: UserBadges
  guest_rating: number
  guest_review_count: number
}

/** A non-sensitive public profile (NEVER phone/email/id). Used on host/guest cards. */
export async function getPublicProfile(userId: string): Promise<PublicProfile | null> {
  if (!isUuid(userId)) return null
  const { rows } = await pool.query(
    `SELECT id, full_name, avatar_url, bio,
            COALESCE(verification_status, 'unverified') AS verification_status,
            COALESCE((SELECT round(avg(g.rating)::numeric, 2) FROM guest_reviews g WHERE g.guest_id = users.id), 0)::float8 AS guest_rating,
            COALESCE((SELECT count(*) FROM guest_reviews g WHERE g.guest_id = users.id), 0)::int AS guest_review_count
       FROM users WHERE id = $1`,
    [userId]
  )
  if (!rows[0]) return null
  const badges = await getUserBadges(userId)
  return { ...(rows[0] as Omit<PublicProfile, 'badges'>), badges }
}

// ---- Reports ----------------------------------------------------------------

const REPORT_TARGETS = ['listing', 'user', 'review'] as const
export type ReportTarget = (typeof REPORT_TARGETS)[number]

export interface Report {
  id: string
  reporter_id: string
  reporter_name: string | null
  target_type: ReportTarget
  target_id: string
  reason: string
  details: string | null
  status: string
  created_at: string
  resolved_at: string | null
}

/** A signed-in user reports a listing / user / review. */
export async function createReport(
  reporterId: string,
  args: { targetType: string; targetId: string; reason: string; details?: string | null }
): Promise<{ id: string }> {
  if (!isUuid(reporterId)) throw new Error('Please sign in')
  const targetType = String(args.targetType ?? '').toLowerCase().trim()
  if (!(REPORT_TARGETS as readonly string[]).includes(targetType)) throw new Error('Invalid report target')
  if (!isUuid(args.targetId)) throw new Error('Invalid target')
  const reason = String(args.reason ?? '').trim()
  if (!reason) throw new Error('Please choose a reason')
  const { rows } = await pool.query(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, details)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [reporterId, targetType, args.targetId, reason.slice(0, 120), (args.details ?? '').toString().trim().slice(0, 2000) || null]
  )
  return { id: rows[0].id as string }
}

/** Reports for the admin triage queue (newest first), with the reporter's name. */
export async function listReports(status?: string): Promise<Report[]> {
  const filterable = status === 'open' || status === 'resolved' || status === 'dismissed'
  const { rows } = await pool.query(
    `SELECT r.id, r.reporter_id, u.full_name AS reporter_name, r.target_type, r.target_id,
            r.reason, r.details, r.status,
            to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
            to_char(r.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS resolved_at
       FROM reports r JOIN users u ON u.id = r.reporter_id
      ${filterable ? 'WHERE r.status = $1' : ''}
      ORDER BY r.created_at DESC`,
    filterable ? [status] : []
  )
  return rows as Report[]
}

/** Admin resolves or dismisses a report. */
export async function resolveReport(reportId: string, status: 'resolved' | 'dismissed'): Promise<boolean> {
  if (!isUuid(reportId)) return false
  const { rowCount } = await pool.query(
    `UPDATE reports SET status = $2, resolved_at = now() WHERE id = $1`,
    [reportId, status]
  )
  return (rowCount ?? 0) > 0
}
