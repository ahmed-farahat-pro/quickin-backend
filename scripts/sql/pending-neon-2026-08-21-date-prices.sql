-- =====================================================================
-- QuickIn — host calendar: per-date nightly pricing.
-- Paste into the Neon SQL editor and run. Safe to re-run.
--
-- Equivalent to:  node backend/quickin-backend/scripts/migrate-date-prices.mjs
--
-- ORDER MATTERS FOR THIS ONE. Unlike most of the additive migrations, this
-- table is read by the per-night stay sum on EVERY quote and EVERY booking:
--
--     COALESCE((SELECT dp.price FROM listing_date_prices dp …), <seasonal ladder>)
--
-- so code that ships before the table exists fails those queries outright.
-- Run this BEFORE deploying quickin-backend or quickin-frontend.
--
-- Nothing is dropped, nothing is rewritten, and there is no backfill: an
-- empty table means every listing prices exactly as it does today.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS listing_date_prices (
  listing_id uuid    NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  date       date    NOT NULL,
  -- The host's RAW nightly rate for this one night, in the listing's currency.
  -- The guest-facing figure is derived at read time by the commission markup and
  -- is never stored (see commission-core.ts) — changing the platform rate must
  -- reprice every calendar instantly, with nothing to backfill and nothing to drift.
  price      numeric(12,2) NOT NULL CHECK (price > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One price per night. Setting a day the host already priced is an UPSERT, not
  -- a second row — two rows would make the ladder's answer depend on row order.
  PRIMARY KEY (listing_id, date)
);

-- The calendar reads one listing over a date window, and the per-night stay sum
-- probes (listing_id, date) once per night. The primary key already serves both;
-- this second index is for the cross-listing "what is priced from today on" reads.
CREATE INDEX IF NOT EXISTS idx_date_prices_date ON listing_date_prices(date);


-- ---------------------------------------------------------------------
-- listing_blocked_dates — created long ago by migrate-availability.mjs, and
-- repeated here because the host calendar now WRITES it (day-level block and
-- unblock, by rewriting the overlapping spans). A database that somehow never
-- ran that migration would fail the calendar's block path.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_blocked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date > start_date)
);
CREATE INDEX IF NOT EXISTS idx_blocked_dates_listing ON listing_blocked_dates(listing_id);


-- =====================================================================
-- VERIFICATION — run after the block above.
-- Expect: table_exists = t, pinned_prices = 0 on a first run.
-- =====================================================================
SELECT
  to_regclass('public.listing_date_prices') IS NOT NULL AS table_exists,
  (SELECT count(*) FROM listing_date_prices)::int       AS pinned_prices,
  (SELECT count(*) FROM listing_blocked_dates)::int     AS existing_blocks;

-- The ladder itself, on one listing, for a week — proves the join works and
-- that an unpinned day still falls through to the listing's own pricing.
-- Replace the id, or leave it: an unknown uuid simply returns no rows.
SELECT to_char(d, 'YYYY-MM-DD') AS date,
       COALESCE(
         (SELECT dp.price FROM listing_date_prices dp
           WHERE dp.listing_id = l.id AND dp.date = d::date),
         CASE
           WHEN extract(dow from d)::int IN (5, 6) AND l.weekend_price IS NOT NULL THEN l.weekend_price
           WHEN (l.monthly_prices ->> extract(month from d)::int::text) ~ '^[0-9.]+$'
                THEN (l.monthly_prices ->> extract(month from d)::int::text)::numeric
           ELSE l.price_per_night
         END
       ) AS raw_nightly
  FROM listings l,
       generate_series(CURRENT_DATE, CURRENT_DATE + 6, interval '1 day') AS d
 WHERE l.id = (SELECT id FROM listings ORDER BY created_at DESC LIMIT 1)
 ORDER BY d;
