-- =============================================================================
-- QuickIn — the migrations outstanding on Neon prod, as plain SQL
-- =============================================================================
-- Transcribed verbatim from the DDL in scripts/migrate-*.mjs, so running this by
-- hand is equivalent to running those scripts. Every statement is additive and
-- IF NOT EXISTS / IF EXISTS, so the whole file is idempotent — re-running it
-- changes nothing and is the intended way to confirm it applied.
--
-- Sections A-C are the three that shipped with backend 723cd25 (2026-08-18).
-- Sections D-E have been outstanding since 2f1afb3 (2026-08-09).
--
-- Nothing here drops or rewrites existing data. The one DROP COLUMN (A) removes
-- a column from a table this file may have just created, and only converges a
-- dev database built by a withdrawn first draft — on prod it is a no-op.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. PREFLIGHT — run this ALONE first and read the answer before continuing.
-- -----------------------------------------------------------------------------
-- The whole reason this file exists is that a migration meant for Neon quietly
-- ran against localhost. Confirm where you are.
SELECT current_database()                            AS database,
       current_user                                  AS role,
       inet_server_addr()                            AS server_ip,
       version()                                     AS server_version;
-- Expect a Neon host. If this says quickin_local, STOP.


-- -----------------------------------------------------------------------------
-- A + B + D + E — tables and their indexes, in one transaction.
-- -----------------------------------------------------------------------------
-- Postgres DDL is transactional, so if any statement fails the whole thing rolls
-- back and you are left exactly where you started. The ranking indexes (C) are
-- deliberately NOT in here — see the note in that section.
BEGIN;

-- === A. host_payout_methods — where QuickIn sends a host's earnings ==========
-- One row per host: user_id is UNIQUE and the API upserts on it, so changing
-- method rewrites the row rather than adding one. account_ref carries the
-- destination WHOLE (IBAN or account number / InstaPay address / wallet number),
-- because every method has to be actually payable.
CREATE TABLE IF NOT EXISTS host_payout_methods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  method         text NOT NULL,              -- bank_account | instapay | wallet
  account_name   text NOT NULL,              -- the payee name a transfer must match
  account_ref    text NOT NULL,              -- IBAN (or account number) | InstaPay address | wallet number
  bank_name      text NOT NULL DEFAULT '',   -- bank only
  iban           text NOT NULL DEFAULT '',   -- bank only
  account_number text NOT NULL DEFAULT '',   -- bank only
  swift_bic      text NOT NULL DEFAULT '',   -- bank only, optional (international transfers)
  branch         text NOT NULL DEFAULT '',   -- bank only, optional
  provider       text NOT NULL DEFAULT '',   -- wallet provider; '' otherwise
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_host_payout_methods_method ON host_payout_methods (method);

-- Converge a database built by the FIRST version of this migration, which had a
-- 'credit_card' method with an expiry instead of a bank account. That version
-- never reached production, so there is nothing to back-fill on Neon.
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS iban           text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS account_number text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS swift_bic      text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS branch         text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS bank_name      text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods DROP COLUMN IF EXISTS expiry;


-- === B. id_change_requests — changing a national ID is reviewed, not typed ===
CREATE TABLE IF NOT EXISTS id_change_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- users.id_document as it stood when the request was filed. Snapshotted so the
  -- reviewer sees the actual before/after even if the column is changed by another
  -- approval in between, and so the audit trail survives the value being overwritten.
  current_value   text,
  requested_value text NOT NULL,
  -- One of DOC_TYPES in src/lib/local/host-verification-core.ts
  -- (national_id | passport | residence_permit). Plain text rather than an enum:
  -- the list lives in code that both projects share, and a CHECK here would need a
  -- migration every time it changed — the same call id_verifications.doc_type made.
  doc_type        text NOT NULL DEFAULT 'national_id',
  -- FRONT of the document, REQUIRED. Without it a reviewer has nothing to check the
  -- typed number against, and approving would be rubber-stamping — which is the very
  -- thing this queue exists to stop. base64 data-URLs inline, the same convention as
  -- id_verifications.image_data.
  image_data      text NOT NULL,
  back_image_data text,
  -- The user's own explanation of the correction, optional.
  reason          text,
  -- pending | approved | rejected. See ID_CHANGE_STATUSES in id-change-core.ts.
  status          text NOT NULL DEFAULT 'pending',
  -- The operator's note. On a rejection this is the reason the user is shown, so it
  -- is not an internal-only field.
  notes           text,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     text
);

-- The /ops queue: everything awaiting a decision, oldest first so the alert centre's
-- "waited 3 days" and the review order agree.
CREATE INDEX IF NOT EXISTS id_change_requests_pending_idx
  ON id_change_requests (submitted_at) WHERE status = 'pending';
-- "My request" on the profile screen, and this user's history in /ops.
CREATE INDEX IF NOT EXISTS id_change_requests_user_idx
  ON id_change_requests (user_id, submitted_at DESC);
-- ONE open request per user, enforced by the database rather than by a read-then-write
-- in the route: two taps on a slow connection would otherwise file two requests, and an
-- operator would approve one identity while the other still claimed a different number.
CREATE UNIQUE INDEX IF NOT EXISTS id_change_requests_one_pending_per_user
  ON id_change_requests (user_id) WHERE status = 'pending';


-- === D. policy_violations + policy_warnings — the contact-detail guard =======
CREATE TABLE IF NOT EXISTS policy_violations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the guard matched: 'phone' | 'email' | 'social' | 'url'.
  kind         text NOT NULL,
  -- Where they tried it: 'chat' | 'review' | 'listing' | 'profile'.
  surface      text NOT NULL,
  body         text NOT NULL,
  -- True when the guard only caught this by stitching the sender's recent
  -- messages together — a deliberate drip-feed reads very differently from one
  -- careless message, and the moderation screen says so.
  split        boolean NOT NULL DEFAULT false,
  -- Which thread/listing it happened in, for the moderator's context. Free text
  -- rather than an FK because the referent differs by surface and a listing can
  -- be deleted without taking the evidence with it.
  context_type text,
  context_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz,
  reviewed_by  text
);

-- The moderation list: users with unreviewed rows, newest first.
CREATE INDEX IF NOT EXISTS policy_violations_open_idx
  ON policy_violations (user_id, created_at DESC) WHERE reviewed_at IS NULL;
-- One user's full history, reviewed or not.
CREATE INDEX IF NOT EXISTS policy_violations_user_idx
  ON policy_violations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_warnings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message         text NOT NULL,
  -- 'staff:<uuid>' — the same free-text actor convention as
  -- payment_proofs.reviewed_by and users.status_changed_by.
  issued_by       text NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

-- The gate is read on EVERY chat send, so it gets a partial index: only
-- unacknowledged rows are ever looked up, and there are very few of them.
CREATE INDEX IF NOT EXISTS policy_warnings_pending_idx
  ON policy_warnings (user_id) WHERE acknowledged_at IS NULL;


-- === E. disputes + dispute_events — the guest dispute queue ==================
CREATE TABLE IF NOT EXISTS disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- Denormalised from the booking so a dispute can still be attributed if the
  -- booking row is ever reshaped, and so "this guest's disputes" is one index.
  guest_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- One of DISPUTE_CATEGORIES in src/lib/local/disputes-core.ts. Plain text
  -- rather than an enum: the list lives in code (both projects share it), and a
  -- CHECK here would need a migration every time it changed.
  category     text NOT NULL,
  description  text NOT NULL,
  -- base64 data-URLs, same convention as payment_proofs.image_data.
  photos       text[] NOT NULL DEFAULT '{}',
  -- open | in_review | resolved | closed
  status       text NOT NULL DEFAULT 'open',
  -- What the admin concluded. Shown back to the guest, so it is not an internal note.
  resolution   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

-- The /ops queue: everything still needing a decision, newest first.
CREATE INDEX IF NOT EXISTS disputes_open_idx
  ON disputes (created_at DESC) WHERE status IN ('open', 'in_review');
-- "My disputes" on the guest's reservations screen.
CREATE INDEX IF NOT EXISTS disputes_guest_idx ON disputes (guest_id, created_at DESC);
-- "Does this booking already have a dispute?" — checked before offering the form.
CREATE INDEX IF NOT EXISTS disputes_booking_idx ON disputes (booking_id);

CREATE TABLE IF NOT EXISTS dispute_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  -- NULL on the filing row: it came from nowhere.
  from_status text,
  to_status   text NOT NULL,
  note        text,
  -- 'guest:<uuid>' or 'staff:<uuid>' — the same free-text actor convention as
  -- payment_proofs.reviewed_by and users.status_changed_by.
  actor       text NOT NULL,
  -- Snapshotted so the timeline still reads correctly after a staff account is
  -- renamed or deactivated.
  actor_name  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispute_events_dispute_idx ON dispute_events (dispute_id, created_at);

COMMIT;


-- -----------------------------------------------------------------------------
-- C. Search-ranking indexes — run these OUTSIDE the transaction above.
-- -----------------------------------------------------------------------------
-- These are the only statements here that touch tables holding real rows
-- (reviews, bookings). A plain CREATE INDEX takes a lock that blocks WRITES to
-- the table while it builds — fine on a small table, not something to do to a
-- busy one mid-day. CONCURRENTLY avoids that, and cannot run inside a
-- transaction, which is why they are separated out. Run them one at a time.
--
-- These are a performance optimisation only: the ranking is CORRECT without
-- them. Nothing is dormant waiting on this section.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_listing_ranking
  ON reviews(listing_id) INCLUDE (rating, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_listing_ranking
  ON bookings(listing_id, status, check_out);
-- If either reports INVALID afterwards (a CONCURRENTLY build can fail and leave
-- a dead index behind), DROP INDEX it and re-run that one statement:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;


-- -----------------------------------------------------------------------------
-- F. VERIFY — expect all five rows to read 'ok'.
-- -----------------------------------------------------------------------------
SELECT 'host_payout_methods' AS object,
       CASE WHEN to_regclass('public.host_payout_methods') IS NULL THEN 'MISSING' ELSE 'ok' END AS state
UNION ALL SELECT 'id_change_requests',
       CASE WHEN to_regclass('public.id_change_requests') IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'policy_violations + policy_warnings',
       CASE WHEN to_regclass('public.policy_violations') IS NULL
              OR to_regclass('public.policy_warnings')  IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'disputes + dispute_events',
       CASE WHEN to_regclass('public.disputes')       IS NULL
              OR to_regclass('public.dispute_events') IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'ranking indexes',
       CASE WHEN (SELECT count(*) FROM pg_indexes
                   WHERE indexname IN ('idx_reviews_listing_ranking',
                                       'idx_bookings_listing_ranking')) = 2
            THEN 'ok' ELSE 'MISSING' END;


-- -----------------------------------------------------------------------------
-- G. OPTIONAL — the reporting the migration scripts printed. Reporting only.
-- -----------------------------------------------------------------------------
-- Approved hosts with nowhere to be paid. Blocks nothing: a host without a
-- payout method can still list and take bookings.
SELECT count(*) AS hosts_without_payout_method
  FROM users u
 WHERE (COALESCE(u.is_host, false) = true OR u.role = 'host')
   AND NOT EXISTS (SELECT 1 FROM host_payout_methods p WHERE p.user_id = u.id);

-- Should always be 0 — the 'credit_card' method was withdrawn before it shipped,
-- and such a row is unpayable (it only ever held the last four digits).
SELECT count(*) AS rows_on_withdrawn_credit_card_method
  FROM host_payout_methods WHERE method = 'credit_card';

-- Accounts carrying a self-declared ID number nobody ever reviewed. They keep
-- their value — approving them retroactively is not a migration's call.
SELECT count(*) AS users_with_unreviewed_id
  FROM users WHERE COALESCE(id_document, '') <> '';
