// S8 — growth: length-of-stay discounts, promo codes, referrals.
//  - listings.weekly_discount / monthly_discount: host-set % off for ≥7 / ≥28 nights.
//  - promo_codes: platform discount codes (percent or fixed), with limits/expiry.
//  - bookings.promo_code / promo_discount: the code applied + amount saved.
//  - users.referral_code: each user's shareable code (backfilled, deterministic).
//  - referrals: who referred whom + mock reward.
//   node quickin-backend/scripts/migrate-growth.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })

const DDL = `
-- Length-of-stay discounts (percent off).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS weekly_discount  int NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS monthly_discount int NOT NULL DEFAULT 0;

-- Promo codes.
CREATE TABLE IF NOT EXISTS promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('percent','fixed')),
  value numeric NOT NULL CHECK (value > 0),
  max_redemptions int,
  times_redeemed int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Promo applied to a booking.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_code text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_discount numeric;

-- Referrals.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text;
CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  reward_amount numeric NOT NULL DEFAULT 200,
  status text NOT NULL DEFAULT 'joined',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id);
`

;(async () => {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
  await pool.query(DDL)
  // Backfill a deterministic 8-char referral code for existing users.
  await pool.query(`UPDATE users SET referral_code = upper(substr(md5(id::text), 1, 8)) WHERE referral_code IS NULL`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_idx ON users(referral_code)`)
  const counts = await pool.query(`SELECT
      (SELECT count(*) FROM users WHERE referral_code IS NOT NULL)::int AS coded_users,
      (SELECT to_regclass('public.promo_codes')) AS promo,
      (SELECT to_regclass('public.referrals')) AS refs`)
  console.log('users with referral_code:', counts.rows[0].coded_users)
  console.log('promo_codes:', counts.rows[0].promo ? '✅' : '❌', ' referrals:', counts.rows[0].refs ? '✅' : '❌')
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
