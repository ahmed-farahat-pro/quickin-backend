// Analytics schema for the /ops reports (B1 bookings, B2 payments, B3 cancellations).
//
// Adds the columns the reports need but that nothing records today, plus the indexes
// every report axis is missing. All additive and unread by the current code, so this
// can (and should) land on Neon well BEFORE either repo deploys.
//
//   - cancelled_by / cancelled_by_role  → B3's "who cancelled". Nothing records the
//                                          actor today; hosts cannot even cancel yet.
//                                          Tracked from deploy onward; older rows
//                                          report as "Unknown".
//   - cancellation_policy               → snapshot of the policy in force AT BOOKING
//                                          TIME. Today it is read live off the
//                                          listing, so a host editing it silently
//                                          re-attributes all their past cancellations.
//   - commission_rate                   → snapshot of the platform rate at booking time.
//   - refunded_at                       → refunds have no date axis today, because
//                                          setBookingPaymentOutcome CLEARS paid_at.
//   - app_settings.platform_commission_rate → the rate itself, seeded from the value
//                                          hardcoded at src/lib/local/money.ts:11.
//
// Idempotent — safe to re-run.
//   node quickin-backend/scripts/migrate-analytics.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const DDL = `
-- B3: who cancelled. TEXT rather than a users FK because staff actors are
-- 'staff:<uuid>' (staffActor() in src/lib/local/staff.ts) — the same convention
-- app_settings.updated_by and payment_proofs.reviewed_by already use.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by      text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by_role text;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_cancelled_by_role_chk;
ALTER TABLE bookings ADD  CONSTRAINT bookings_cancelled_by_role_chk
  CHECK (cancelled_by_role IS NULL OR cancelled_by_role IN ('guest','host','admin','system'));

-- B3: the policy in force AT BOOKING TIME. Deliberately NOT backfilled from
-- listings.cancellation_policy — the listing's CURRENT policy is not evidence of
-- what it was months ago. NULL reads as "Unknown", same rule as cancelled_by.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_policy text;

-- B2: the platform rate in force at booking time, so historical commission stays
-- correct after the rate is ever changed.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS commission_rate numeric(5,4);

-- B2: setBookingPaymentOutcome('refunded') sets paid_at = NULL (src/lib/local/db.ts),
-- which leaves a refunded booking with NO date at all. This gives refunds their own
-- axis. Additive: nothing reads it yet, so no existing behaviour changes.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- B2: the rate itself. Seeded with the value hardcoded today as HOST_COMMISSION
-- in src/lib/local/money.ts, so behaviour is unchanged until an admin edits it.
INSERT INTO app_settings (key, value) VALUES ('platform_commission_rate', '0.1')
  ON CONFLICT (key) DO NOTHING;

-- ---- Analytics indexes --------------------------------------------------------
-- bookings has ONLY: the PK, idx_bookings_user, idx_bookings_listing and the
-- reservation_code unique index. Every axis these reports filter or group on is
-- unindexed today.
CREATE INDEX IF NOT EXISTS idx_bookings_created_at     ON bookings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_status_created ON bookings (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_check_in       ON bookings (check_in);
CREATE INDEX IF NOT EXISTS idx_bookings_check_out      ON bookings (check_out);
-- Partial on payment_status, NOT on "paid_at IS NOT NULL" — that predicate silently
-- drops every refunded booking, because the refund path clears paid_at.
CREATE INDEX IF NOT EXISTS idx_bookings_paid
  ON bookings (paid_at DESC) WHERE payment_status = 'paid';
CREATE INDEX IF NOT EXISTS idx_bookings_cancelled
  ON bookings (cancelled_at DESC) WHERE cancelled_at IS NOT NULL;
`

const url = databaseUrl()
const isLocal = url.includes('127.0.0.1') || url.includes('localhost')
const pool = new pg.Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)

  // Backfill commission_rate on existing PAID bookings only, with the rate that was
  // in force when they were taken (the hardcoded 0.1). Unpaid/pending bookings are
  // left NULL so they pick up the live rate when they are actually paid.
  const back = await pool.query(
    `UPDATE bookings SET commission_rate = 0.1
      WHERE commission_rate IS NULL AND COALESCE(payment_status, 'unpaid') = 'paid'`
  )

  // ---- verify -----------------------------------------------------------------
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'bookings'
        AND column_name IN ('cancelled_by','cancelled_by_role','cancellation_policy',
                            'commission_rate','refunded_at')
      ORDER BY column_name`
  )
  const want = ['cancellation_policy', 'cancelled_by', 'cancelled_by_role', 'commission_rate', 'refunded_at']
  const got = cols.rows.map((r) => r.column_name)
  const missing = want.filter((c) => !got.includes(c))
  if (missing.length) throw new Error(`columns missing after DDL: ${missing.join(', ')}`)

  const idx = await pool.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE tablename = 'bookings' AND indexname LIKE 'idx_bookings_%'`
  )
  const rate = await pool.query(`SELECT value FROM app_settings WHERE key = 'platform_commission_rate'`)

  console.log(
    `✅ analytics schema ready — ${got.length}/5 columns, ${idx.rows[0].n} bookings indexes, ` +
    `commission rate ${rate.rows[0]?.value ?? '(unset)'}, ${back.rowCount} paid booking(s) backfilled`
  )
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
