// Resorts — the catalog a listing belongs to, and the "Other" submission path.
//
// A listing points at EITHER a catalog resort (resort_id) OR free text the host
// typed (resort_name), never both — a CHECK constraint enforces it. Free text still
// publishes and is shown to guests as typed; it just queues for an admin to approve,
// rename or merge.
//
// The pure naming rules live in resort-core.ts (unit-tested, no imports). This file
// is the SQL layer. A near-identical copy exists in quickin-frontend — both projects
// create listings (iOS here, web there), so both need the write path.
import { pool } from './pool'
import { normalizeResortName, resortSlug, isRegion } from './resort-core'

export interface ResortOption {
  id: string
  name: string
  region: string
}

/** The host dropdown. Inactive resorts are hidden but keep their listings. */
export async function listActiveResorts(region?: string | null): Promise<ResortOption[]> {
  const { rows } = await pool.query<ResortOption>(
    `SELECT id, name, region FROM resorts
      WHERE is_active AND ($1::text IS NULL OR region = $1)
      ORDER BY region, name`,
    [region && isRegion(region) ? region : null]
  )
  return rows
}

/** What a listing write should store for its resort columns. */
export interface ResortSelection {
  resort_id: string | null
  resort_name: string | null
  /** Derived from the resort when one is matched; otherwise the caller's own value. */
  region: string | null
}

/**
 * Resolve a host's resort choice into the three columns to store.
 *
 * Order matters, and each step exists for a reason:
 *   1. An explicit resort_id wins — the host picked from the dropdown.
 *   2. A typed name that matches a KNOWN ALIAS links straight to the canonical
 *      resort. This is what makes a merge permanent: once an admin has merged
 *      'amouge' into 'Amouage', the next host to type it is silently corrected
 *      instead of re-queueing the same submission forever.
 *   3. A typed name matching an existing resort's slug links to it — the host typed
 *      a name that is already in the catalog, just not picked from the list.
 *   4. Anything else is kept as free text AND queued for moderation.
 *
 * Region is derived from the resort whenever one is matched: that is the whole point
 * of a resort belonging to a region, and it stops a Cairo listing being tagged
 * Marassi.
 */
export async function resolveResortSelection(input: {
  resortId?: string | null
  resortName?: string | null
  region?: string | null
  /** The host, recorded on a submission so an admin can see who asked. */
  userId?: string | null
}): Promise<ResortSelection> {
  const fallbackRegion = input.region && isRegion(input.region) ? input.region : null

  // 1. Picked from the dropdown.
  if (input.resortId) {
    const { rows } = await pool.query<{ id: string; region: string }>(
      `SELECT id, region FROM resorts WHERE id = $1::uuid AND is_active`,
      [input.resortId]
    )
    if (rows[0]) return { resort_id: rows[0].id, resort_name: null, region: rows[0].region }
    // An unknown/retired id is treated as "no choice" rather than an error — the
    // host should not be blocked because an admin deactivated a resort mid-edit.
    return { resort_id: null, resort_name: null, region: fallbackRegion }
  }

  const typed = normalizeResortName(input.resortName)
  if (!typed) return { resort_id: null, resort_name: null, region: fallbackRegion }

  const slug = resortSlug(typed)
  if (!slug) return { resort_id: null, resort_name: null, region: fallbackRegion }

  // 2 + 3. A previously-merged misspelling, or an existing catalog name.
  const { rows: matched } = await pool.query<{ id: string; region: string }>(
    `SELECT r.id, r.region FROM resorts r
      WHERE r.is_active AND (r.slug = $1 OR r.id = (SELECT resort_id FROM resort_aliases WHERE slug = $1))
      LIMIT 1`,
    [slug]
  )
  if (matched[0]) return { resort_id: matched[0].id, resort_name: null, region: matched[0].region }

  // 4. Genuinely new — keep the host's text and queue it.
  await queueResortSubmission({ slug, rawName: typed, region: fallbackRegion, userId: input.userId ?? null })
  return { resort_id: null, resort_name: typed, region: fallbackRegion }
}

/**
 * Record an unknown resort name for the /ops queue. One PENDING row per slug (a
 * partial unique index enforces it), so twenty hosts typing the same compound
 * produce one thing for an admin to decide, not twenty.
 *
 * Best-effort: a listing must never fail to save because the moderation queue
 * had a problem.
 */
async function queueResortSubmission(input: {
  slug: string
  rawName: string
  region: string | null
  userId: string | null
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO resort_submissions (slug, raw_name, region, submitted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) WHERE status = 'pending'
       DO UPDATE SET last_seen_at = now(),
                     region = COALESCE(resort_submissions.region, EXCLUDED.region)`,
      [input.slug, input.rawName, input.region, input.userId]
    )
  } catch (err) {
    console.error('resort submission queue:', err)
  }
}
