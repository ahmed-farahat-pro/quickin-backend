import { pool } from './pool'

// Growth: promo codes + referrals (S8). Promo discounts are computed against a
// subtotal (EGP). Referral rewards are mock credit (no real payout).

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

// ---- Promo codes ------------------------------------------------------------

export interface PromoCode {
  id: string
  code: string
  kind: 'percent' | 'fixed'
  value: number
  max_redemptions: number | null
  times_redeemed: number
  active: boolean
  expires_at: string | null
  created_at: string
}

export interface PromoQuote {
  valid: boolean
  code: string
  kind?: 'percent' | 'fixed'
  value?: number
  discount: number
  message?: string
}

/** Validate a code against a subtotal and return the discount it would apply
 *  (no mutation). Discount is capped at the subtotal. */
export async function quotePromo(rawCode: string, subtotal: number): Promise<PromoQuote> {
  const code = String(rawCode ?? '').trim().toUpperCase()
  const sub = Math.max(0, Number(subtotal) || 0)
  if (!code) return { valid: false, code: '', discount: 0, message: 'Enter a promo code' }
  const { rows } = await pool.query(
    `SELECT kind, value::float8 AS value, max_redemptions, times_redeemed, active, expires_at
       FROM promo_codes WHERE upper(code) = $1`,
    [code]
  )
  const p = rows[0]
  if (!p || !p.active) return { valid: false, code, discount: 0, message: 'Invalid promo code' }
  if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) {
    return { valid: false, code, discount: 0, message: 'This code has expired' }
  }
  if (p.max_redemptions != null && p.times_redeemed >= p.max_redemptions) {
    return { valid: false, code, discount: 0, message: 'This code has reached its limit' }
  }
  const raw = p.kind === 'percent' ? (sub * Number(p.value)) / 100 : Number(p.value)
  const discount = Math.min(sub, Math.round(raw))
  return { valid: true, code, kind: p.kind, value: Number(p.value), discount }
}

/** Atomically redeem a code (increments times_redeemed if still valid). Returns
 *  the discount actually applied, or 0 if the code is invalid/exhausted. */
export async function redeemPromo(rawCode: string, subtotal: number): Promise<number> {
  const quote = await quotePromo(rawCode, subtotal)
  if (!quote.valid) return 0
  const { rowCount } = await pool.query(
    `UPDATE promo_codes
        SET times_redeemed = times_redeemed + 1
      WHERE upper(code) = $1 AND active = true
        AND (expires_at IS NULL OR expires_at > now())
        AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)`,
    [quote.code]
  )
  return rowCount ? quote.discount : 0
}

// Admin CRUD.
export async function createPromo(args: {
  code: string
  kind: string
  value: number
  maxRedemptions?: number | null
  expiresAt?: string | null
}): Promise<PromoCode> {
  const code = String(args.code ?? '').trim().toUpperCase()
  if (!code) throw new Error('Code is required')
  const kind = args.kind === 'fixed' ? 'fixed' : 'percent'
  const value = Number(args.value)
  if (!Number.isFinite(value) || value <= 0) throw new Error('Value must be positive')
  if (kind === 'percent' && value > 100) throw new Error('Percent cannot exceed 100')
  const max = args.maxRedemptions == null || args.maxRedemptions === ('' as unknown) ? null : Math.max(1, Math.floor(Number(args.maxRedemptions)))
  const expires = args.expiresAt ? new Date(args.expiresAt).toISOString() : null
  const { rows } = await pool.query(
    `INSERT INTO promo_codes (code, kind, value, max_redemptions, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, value = EXCLUDED.value,
       max_redemptions = EXCLUDED.max_redemptions, expires_at = EXCLUDED.expires_at, active = true
     RETURNING id, code, kind, value::float8 AS value, max_redemptions, times_redeemed, active,
               to_char(expires_at, 'YYYY-MM-DD') AS expires_at, to_char(created_at, 'YYYY-MM-DD') AS created_at`,
    [code, kind, value, max, expires]
  )
  return rows[0] as PromoCode
}

export async function listPromos(): Promise<PromoCode[]> {
  const { rows } = await pool.query(
    `SELECT id, code, kind, value::float8 AS value, max_redemptions, times_redeemed, active,
            to_char(expires_at, 'YYYY-MM-DD') AS expires_at, to_char(created_at, 'YYYY-MM-DD') AS created_at
       FROM promo_codes ORDER BY created_at DESC`
  )
  return rows as PromoCode[]
}

export async function setPromoActive(id: string, active: boolean): Promise<boolean> {
  if (!isUuid(id)) return false
  const { rowCount } = await pool.query(`UPDATE promo_codes SET active = $2 WHERE id = $1`, [id, active])
  return (rowCount ?? 0) > 0
}

export async function deletePromo(id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const { rowCount } = await pool.query(`DELETE FROM promo_codes WHERE id = $1`, [id])
  return (rowCount ?? 0) > 0
}

// ---- Referrals --------------------------------------------------------------

export interface ReferralSummary {
  code: string | null
  count: number
  rewardTotal: number
  referred: { name: string | null; created_at: string; reward_amount: number }[]
}

/** The signed-in user's referral code + who they've referred + total mock reward. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  if (!isUuid(userId)) return { code: null, count: 0, rewardTotal: 0, referred: [] }
  const codeRow = await pool.query(`SELECT referral_code FROM users WHERE id = $1`, [userId])
  const code = (codeRow.rows[0]?.referral_code as string) ?? null
  const { rows } = await pool.query(
    `SELECT u.full_name AS name, to_char(r.created_at, 'YYYY-MM-DD') AS created_at, r.reward_amount::float8 AS reward_amount
       FROM referrals r JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = $1 ORDER BY r.created_at DESC`,
    [userId]
  )
  const rewardTotal = rows.reduce((s, r) => s + Number(r.reward_amount || 0), 0)
  return { code, count: rows.length, rewardTotal, referred: rows as ReferralSummary['referred'] }
}

/** Record that `newUserId` joined via `referralCode` (mock reward to the owner).
 *  Safe to call once per new user; ignores self-referral / unknown codes. */
export async function recordReferral(newUserId: string, referralCode: string): Promise<boolean> {
  if (!isUuid(newUserId)) return false
  const code = String(referralCode ?? '').trim().toUpperCase()
  if (!code) return false
  const owner = await pool.query(`SELECT id FROM users WHERE upper(referral_code) = $1`, [code])
  const referrerId = owner.rows[0]?.id as string | undefined
  if (!referrerId || referrerId === newUserId) return false
  const { rowCount } = await pool.query(
    `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)
     ON CONFLICT (referred_id) DO NOTHING`,
    [referrerId, newUserId]
  )
  return (rowCount ?? 0) > 0
}

/** Ensure a user has a referral code (generates a deterministic one if missing). */
export async function ensureReferralCode(userId: string): Promise<string | null> {
  if (!isUuid(userId)) return null
  const { rows } = await pool.query(
    `UPDATE users SET referral_code = COALESCE(referral_code, upper(substr(md5(id::text), 1, 8)))
      WHERE id = $1 RETURNING referral_code`,
    [userId]
  )
  return (rows[0]?.referral_code as string) ?? null
}
