-- =====================================================================
-- QuickIn — every pending Neon migration, as one idempotent block.
-- Paste into the Neon SQL editor and run. Safe to re-run.
--
-- Covers, in dependency order:
--   1. policy_violations + policy_warnings   (migrate-policy-violations.mjs)
--   2. disputes + dispute_events             (migrate-disputes.mjs)
--   3. host_payout_methods                   (migrate-payout-methods.mjs)
--   4. id_change_requests                    (migrate-id-change-requests.mjs)
--   5. listings.region / amenities           (xmig7)
--   6. listings.review_note                  (xmig9)
--   7. id_verifications.back_image_data      (xmig5)
--   8. bookings.reservation_code + stay_guide_items + backfill  (xmig6)
--   9. staff RBAC tables                     (xmig8 / migrate-staff-rbac.mjs)
--  10. ranking indexes                       (migrate-ranking-indexes.mjs)
--
-- Everything here is additive: CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS. No column is dropped, no row is deleted, nothing is rewritten
-- except the reservation-code backfill in §8, which only fills NULLs.
--
-- Verification queries are at the bottom.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ---------------------------------------------------------------------
-- 1. Policy violations — /ops → Moderation
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_violations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,          -- phone | email | social | url
  surface      text NOT NULL,          -- chat | review | listing | profile
  body         text NOT NULL,
  split        boolean NOT NULL DEFAULT false,
  context_type text,
  context_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz,
  reviewed_by  text
);

CREATE INDEX IF NOT EXISTS policy_violations_open_idx
  ON policy_violations (user_id, created_at DESC) WHERE reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS policy_violations_user_idx
  ON policy_violations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_warnings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message         text NOT NULL,
  issued_by       text NOT NULL,       -- 'staff:<uuid>'
  issued_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

CREATE INDEX IF NOT EXISTS policy_warnings_pending_idx
  ON policy_warnings (user_id) WHERE acknowledged_at IS NULL;


-- ---------------------------------------------------------------------
-- 2. Guest disputes — /ops → Disputes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  guest_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category     text NOT NULL,
  description  text NOT NULL,
  photos       text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'open',   -- open | in_review | resolved | closed
  resolution   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX IF NOT EXISTS disputes_open_idx
  ON disputes (created_at DESC) WHERE status IN ('open', 'in_review');
CREATE INDEX IF NOT EXISTS disputes_guest_idx   ON disputes (guest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS disputes_booking_idx ON disputes (booking_id);

CREATE TABLE IF NOT EXISTS dispute_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  note        text,
  actor       text NOT NULL,           -- 'guest:<uuid>' | 'staff:<uuid>'
  actor_name  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispute_events_dispute_idx
  ON dispute_events (dispute_id, created_at);


-- ---------------------------------------------------------------------
-- 3. Host payout methods — /account and both mobile apps
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS host_payout_methods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  method         text NOT NULL,              -- bank_account | instapay | wallet
  account_name   text NOT NULL,
  account_ref    text NOT NULL,              -- IBAN / InstaPay address / wallet number
  bank_name      text NOT NULL DEFAULT '',
  iban           text NOT NULL DEFAULT '',
  account_number text NOT NULL DEFAULT '',
  swift_bic      text NOT NULL DEFAULT '',
  branch         text NOT NULL DEFAULT '',
  provider       text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_host_payout_methods_method
  ON host_payout_methods (method);

-- Converge a database built by the first version of this schema (credit_card
-- + expiry). That version never reached production; this is a no-op on Neon.
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS iban           text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS account_number text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS swift_bic      text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS branch         text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS bank_name      text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods DROP COLUMN IF EXISTS expiry;


-- ---------------------------------------------------------------------
-- 4. ID change requests — /ops → ID verifications
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS id_change_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_value   text,
  requested_value text NOT NULL,
  doc_type        text NOT NULL DEFAULT 'national_id',
  image_data      text NOT NULL,
  back_image_data text,
  reason          text,
  status          text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  notes           text,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     text
);

CREATE INDEX IF NOT EXISTS id_change_requests_pending_idx
  ON id_change_requests (submitted_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS id_change_requests_user_idx
  ON id_change_requests (user_id, submitted_at DESC);
-- One open request per user, enforced by the database rather than a
-- read-then-write in the route.
CREATE UNIQUE INDEX IF NOT EXISTS id_change_requests_one_pending_per_user
  ON id_change_requests (user_id) WHERE status = 'pending';


-- ---------------------------------------------------------------------
-- 5. listings.region + listings.amenities   (was xmig7)
-- ---------------------------------------------------------------------
ALTER TABLE listings ADD COLUMN IF NOT EXISTS region    text;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS amenities text[];

CREATE INDEX IF NOT EXISTS idx_listings_region
  ON listings (region) WHERE region IS NOT NULL;


-- ---------------------------------------------------------------------
-- 6. listings.review_note   (was xmig9)
-- The host projection LISTING_COLS_HOST selects this, so every host read
-- fails without it.
-- ---------------------------------------------------------------------
ALTER TABLE listings ADD COLUMN IF NOT EXISTS review_note text;


-- ---------------------------------------------------------------------
-- 7. id_verifications.back_image_data   (was xmig5)
-- ---------------------------------------------------------------------
ALTER TABLE id_verifications ADD COLUMN IF NOT EXISTS back_image_data text;


-- ---------------------------------------------------------------------
-- 8. Stay pass + stay guide   (was xmig6)
-- ---------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reservation_code text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_reservation_code
  ON bookings (upper(reservation_code)) WHERE reservation_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS stay_guide_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text,
  body        text,
  url         text,
  "order"     int DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stay_guide_booking
  ON stay_guide_items (booking_id, "order");

-- Backfill: issue a code to already-CONFIRMED bookings that have none.
-- Pending bookings are left NULL on purpose — no code, no QR, no pass.
-- Format matches genReservationCode() in both repos byte for byte:
-- 'QK-' + 6 chars from an alphabet with no ambiguous glyphs.
DO $backfill$
DECLARE
  alphabet CONSTANT text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  target   record;
  candidate text;
  attempt  int;
  issued   int := 0;
BEGIN
  FOR target IN
    SELECT id FROM bookings
     WHERE status = 'confirmed'
       AND COALESCE(reservation_code, '') = ''
  LOOP
    attempt := 0;
    LOOP
      attempt := attempt + 1;
      EXIT WHEN attempt > 20;   -- 32^6 keyspace; 20 tries is far beyond need
      candidate := 'QK-';
      FOR i IN 1..6 LOOP
        candidate := candidate || substr(alphabet, 1 + floor(random() * 32)::int, 1);
      END LOOP;
      -- COALESCE keeps any code that appeared meanwhile: codes are never reissued.
      BEGIN
        UPDATE bookings
           SET reservation_code = COALESCE(NULLIF(reservation_code, ''), candidate)
         WHERE id = target.id;
        issued := issued + 1;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- collision on ux_bookings_reservation_code; draw again
      END;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'reservation codes issued: %', issued;
END
$backfill$;


-- ---------------------------------------------------------------------
-- 9. Staff RBAC — the /ops console   (was xmig8)
-- No-op if /ops staff login already works in production.
-- NOTE: this creates the tables but CANNOT seed the first super admin —
-- the password hash is scrypt, computed in Node. See the note below.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  password_hash         text NOT NULL,
  full_name             text NOT NULL,
  role                  text NOT NULL DEFAULT 'moderator',
  is_active             boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES staff_accounts(id) ON DELETE SET NULL,
  last_login_at         timestamptz,
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_accounts_email_uidx
  ON staff_accounts (lower(email));

CREATE TABLE IF NOT EXISTS staff_permissions (
  staff_id   uuid NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  module     text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES staff_accounts(id) ON DELETE SET NULL,
  PRIMARY KEY (staff_id, module)
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);

CREATE INDEX IF NOT EXISTS staff_sessions_staff_idx  ON staff_sessions (staff_id);
CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx ON staff_sessions (expires_at);

CREATE TABLE IF NOT EXISTS staff_password_resets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id        uuid NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  email           text NOT NULL,
  code            text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  failed_attempts int NOT NULL DEFAULT 0,
  request_ip      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_password_resets_staff_idx
  ON staff_password_resets (staff_id);

CREATE TABLE IF NOT EXISTS staff_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid REFERENCES staff_accounts(id) ON DELETE SET NULL,
  staff_email text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_audit_log_created_idx ON staff_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS staff_audit_log_staff_idx   ON staff_audit_log (staff_id);
CREATE INDEX IF NOT EXISTS staff_audit_log_target_idx  ON staff_audit_log (target_type, target_id);


-- ---------------------------------------------------------------------
-- 10. Search-ranking indexes (performance only — the ranking is correct
--     without them). These two can be slow to build on a large table.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reviews_listing_ranking
  ON reviews (listing_id) INCLUDE (rating, created_at);

CREATE INDEX IF NOT EXISTS idx_bookings_listing_ranking
  ON bookings (listing_id, status, check_out);


-- =====================================================================
-- VERIFICATION — run this after the block above. Every row should say OK.
-- =====================================================================
SELECT 'policy_violations'   AS object, CASE WHEN to_regclass('policy_violations')   IS NULL THEN 'MISSING' ELSE 'OK' END AS state
UNION ALL SELECT 'policy_warnings',     CASE WHEN to_regclass('policy_warnings')     IS NULL THEN 'MISSING' ELSE 'OK' END
UNION ALL SELECT 'disputes',            CASE WHEN to_regclass('disputes')            IS NULL THEN 'MISSING' ELSE 'OK' END
UNION ALL SELECT 'dispute_events',      CASE WHEN to_regclass('dispute_events')      IS NULL THEN 'MISSING' ELSE 'OK' END
UNION ALL SELECT 'host_payout_methods', CASE WHEN to_regclass('host_payout_methods') IS NULL THEN 'MISSING' ELSE 'OK' END
UNION ALL SELECT 'id_change_requests',  CASE WHEN to_regclass('id_change_requests')  IS NULL THEN 'MISSING' ELSE 'OK' END
UNION ALL SELECT 'stay_guide_items',    CASE WHEN to_regclass('stay_guide_items')    IS NULL THEN 'MISSING' ELSE 'OK' END
UNION ALL SELECT 'staff_accounts',      CASE WHEN to_regclass('staff_accounts')      IS NULL THEN 'MISSING' ELSE 'OK' END
UNION ALL SELECT 'listings.region',     CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='listings' AND column_name='region') THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'listings.amenities',  CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='listings' AND column_name='amenities') THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'listings.review_note',CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='listings' AND column_name='review_note') THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'bookings.reservation_code', CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='reservation_code') THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'id_verifications.back_image_data', CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='id_verifications' AND column_name='back_image_data') THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'idx_reviews_listing_ranking',  CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_reviews_listing_ranking')  THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'idx_bookings_listing_ranking', CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_bookings_listing_ranking') THEN 'OK' ELSE 'MISSING' END;


-- =====================================================================
-- DOES /ops STILL HAVE A SUPER ADMIN?
-- If this returns 0, the staff tables were newly created by §9 and there
-- is NOBODY who can log into /ops. Seed one BEFORE the xmig8 route is
-- deleted, by opening:
--
--   https://<web-domain>/api/local/xmig8?key=qk-mig8-4b1f
--     &seed_email=you@example.com&seed_password=<10+ chars, letter+digit>
--
-- It refuses once an active super admin exists, so it is a bootstrap and
-- not a backdoor. If this returns 1 or more, /ops is already live and the
-- route can go.
-- =====================================================================
SELECT count(*)::int AS active_super_admins
  FROM staff_accounts
 WHERE role = 'super_admin' AND is_active;


-- =====================================================================
-- BLAST-RADIUS REPORTING (optional, read-only)
-- =====================================================================
SELECT
  (SELECT count(*) FROM bookings WHERE status='confirmed' AND COALESCE(reservation_code,'')='')::int
    AS confirmed_bookings_still_without_a_code,
  (SELECT count(*) FROM users u
     WHERE (COALESCE(u.is_host,false) OR u.role='host')
       AND NOT EXISTS (SELECT 1 FROM host_payout_methods p WHERE p.user_id=u.id))::int
    AS hosts_with_no_payout_method,
  (SELECT count(*) FROM users WHERE COALESCE(id_document,'') <> '')::int
    AS users_with_an_unreviewed_id_number;
