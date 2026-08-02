// Resorts catalog — the curated list of compounds/resorts a listing belongs to
// (Marassi, Amouage, Porto Sokhna, …). Replaces "city" as the geographic facet:
// listings.location is free text and unusable for grouping, and there is no city
// column anywhere.
//
//   - resorts            → the catalog. A resort BELONGS TO one region, so
//                          listings.region is derived from it.
//   - resort_aliases     → every misspelling ever merged into a canonical resort,
//                          so a host typing 'amouge' again auto-links instead of
//                          re-queueing.
//   - resort_submissions → the /ops moderation queue: one row per DISTINCT
//                          normalized name a host typed via the "Other" option.
//   - listings.resort_id / resort_name → EITHER a catalog resort OR free text,
//                          never both (enforced by a CHECK). Free text still
//                          publishes and is shown to guests as typed; it just
//                          groups under "Others" in reports until an admin
//                          approves it.
//
// Idempotent — safe to re-run, and safe against prod (everything IF NOT EXISTS).
//   node quickin-backend/scripts/migrate-resorts.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

// ---------------------------------------------------------------------------
// STARTER CATALOG — curate this.
// Drawn from the compounds that actually appear in scripts/seed-demo.mjs plus the
// ones product named. It is a starting point, NOT an authority: the admin adds,
// renames and deactivates from /ops → Resorts. Re-running this script only ever
// INSERTs missing slugs (ON CONFLICT DO NOTHING), so it never overwrites a name an
// admin has corrected.
// Region must be one of REGIONS in src/lib/local/db.ts:
//   'North Coast' | 'Ain Sokhna' | 'El Gouna' | 'Cairo'
// ---------------------------------------------------------------------------
const SEED = [
  ['Marassi', 'North Coast'],
  ['Hacienda Bay', 'North Coast'],
  ['Fouka Bay', 'North Coast'],
  ['Sidi Abdel Rahman', 'North Coast'],
  ['Amouage', 'North Coast'],
  ['SouthMed', 'North Coast'],
  ['Porto Sokhna', 'Ain Sokhna'],
  ['Stella Di Mare', 'Ain Sokhna'],
  ['Ain Sokhna Marina', 'Ain Sokhna'],
  ['Abu Tig Marina', 'El Gouna'],
  ['El Gouna Reef', 'El Gouna'],
]

/** MUST stay identical to resortSlug() in src/lib/local/resort-core.ts.
 *  Duplicated here because a migration script cannot import a .ts module that
 *  itself imports anything; check-resort-core-parity.mjs guards the real pair. */
function resortSlug(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')           // punctuation → space
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 120)
}

const DDL = `
-- The curated catalog. slug is the normalized match key (resortSlug), so
-- 'Amouage', 'amouage ' and 'AMOUAGE' all collide on one row.
CREATE TABLE IF NOT EXISTS resorts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL,
  region     text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,   -- false hides it from the host dropdown, keeps history
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,                            -- staffActor() → 'staff:<uuid>'
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS resorts_slug_uidx  ON resorts (slug);
CREATE INDEX        IF NOT EXISTS resorts_region_idx ON resorts (region) WHERE is_active;

-- Merged misspellings. Makes a merge PERMANENT rather than a one-off cleanup:
-- the write path checks this table before queueing a new submission.
CREATE TABLE IF NOT EXISTS resort_aliases (
  slug       text PRIMARY KEY,
  resort_id  uuid NOT NULL REFERENCES resorts(id) ON DELETE CASCADE,
  label      text NOT NULL,                   -- the raw text as first submitted
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS resort_aliases_resort_idx ON resort_aliases (resort_id);

-- The moderation queue. One row per distinct slug while pending; resolved rows are
-- kept for history, which is why the unique index is partial.
CREATE TABLE IF NOT EXISTS resort_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  raw_name      text NOT NULL,                -- exactly what the host typed
  region        text,
  status        text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  submitted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  resolved_by   text,
  reject_reason text,
  resort_id     uuid REFERENCES resorts(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS resort_submissions_pending_uidx
  ON resort_submissions (slug) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS resort_submissions_status_idx
  ON resort_submissions (status, last_seen_at DESC);

-- A listing points at EITHER the catalog or free text, never both.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS resort_id   uuid REFERENCES resorts(id) ON DELETE SET NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS resort_name text;
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_resort_choice_chk;
ALTER TABLE listings ADD  CONSTRAINT listings_resort_choice_chk
  CHECK (resort_id IS NULL OR resort_name IS NULL);

CREATE INDEX IF NOT EXISTS idx_listings_resort ON listings (resort_id) WHERE resort_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_resort_free
  ON listings (lower(btrim(resort_name))) WHERE resort_id IS NULL AND resort_name IS NOT NULL;
-- Declared here because it exists in PROD ONLY — created ad-hoc by the xmig7 route,
-- never by a migration, so a fresh database silently lacks it.
CREATE INDEX IF NOT EXISTS idx_listings_region ON listings (region) WHERE region IS NOT NULL;
`

const url = databaseUrl()
const isLocal = url.includes('127.0.0.1') || url.includes('localhost')
const pool = new pg.Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
  await pool.query(DDL)

  // ---- seed the catalog (never overwrites an admin-corrected name) ----------
  for (const [name, region] of SEED) {
    await pool.query(
      `INSERT INTO resorts (name, slug, region, created_by) VALUES ($1, $2, $3, 'migration')
       ON CONFLICT (slug) DO NOTHING`,
      [name, resortSlug(name), region]
    )
  }

  // ---- backfill from listings.location -------------------------------------
  // Deliberately conservative: a listing is linked only when EXACTLY ONE resort
  // name appears in its free-text location. Ambiguous or unmatched rows stay
  // Unassigned and surface in the /ops unassigned panel — guessing here would
  // create wrong data that is tedious to unpick.
  const linked = await pool.query(
    `WITH matches AS (
       SELECT l.id AS listing_id, min(r.id::text)::uuid AS resort_id, count(*) AS n
         FROM listings l
         JOIN resorts r
           ON l.location ILIKE '%' || r.name || '%'
        WHERE l.resort_id IS NULL AND l.resort_name IS NULL AND l.location IS NOT NULL
        GROUP BY l.id
     )
     UPDATE listings l SET resort_id = m.resort_id
       FROM matches m
      WHERE l.id = m.listing_id AND m.n = 1
      RETURNING l.id`
  )

  // Region follows the resort — that is the whole point of the resort→region link.
  await pool.query(
    `UPDATE listings l SET region = r.region
       FROM resorts r
      WHERE l.resort_id = r.id AND (l.region IS DISTINCT FROM r.region)`
  )

  // ---- verify ---------------------------------------------------------------
  const { rows: missing } = await pool.query(
    `SELECT t AS name FROM unnest(ARRAY['resorts','resort_aliases','resort_submissions']) AS t
      WHERE to_regclass('public.' || t) IS NULL`
  )
  if (missing.length) throw new Error(`tables missing after DDL: ${missing.map((r) => r.name).join(', ')}`)

  const c = await pool.query(`SELECT count(*)::int AS n FROM resorts`)
  const dist = await pool.query(
    `SELECT COALESCE(r.name, CASE WHEN l.resort_name IS NOT NULL THEN '(other: ' || l.resort_name || ')'
                                  ELSE '(unassigned)' END) AS label,
            count(*)::int AS n
       FROM listings l LEFT JOIN resorts r ON r.id = l.resort_id
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`
  )

  console.log(`✅ resorts ready — ${c.rows[0].n} in catalog, ${linked.rowCount} listing(s) auto-linked`)
  for (const r of dist.rows) console.log(`   ${String(r.n).padStart(4)}  ${r.label}`)
  const un = dist.rows.find((r) => r.label === '(unassigned)')
  if (un) console.log(`   ↑ assign the unassigned ones from /ops → Resorts`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
