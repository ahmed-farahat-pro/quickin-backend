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
import { normalizeResortName, resortSlug, isRegion, isValidResortName } from './resort-core'

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
  // The STORAGE backstop for the form rule: text that isn't a name ('@@@@@') is
  // treated as no answer rather than written to the column. Every caller checks
  // it first and answers 400, so reaching this means a caller forgot.
  if (!typed || !isValidResortName(typed)) return { resort_id: null, resort_name: null, region: fallbackRegion }

  // No slug is not "no answer": resortSlug() keeps only [a-z0-9], so a name typed
  // in Arabic reduces to ''. It still gets STORED and shown to guests as typed —
  // it just has no match key, so it can't auto-link, and it can't be queued
  // (resort_submissions is keyed on the slug). An admin still sees it, in the
  // unassigned-names sweep. Returning null here is what used to make a host's
  // Arabic answer disappear on save.
  const slug = resortSlug(typed)
  if (!slug) return { resort_id: null, resort_name: typed, region: fallbackRegion }

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


// ---- /ops additions, ported from quickin-frontend 21 Aug 2026 ----

export interface ApproveResult {
  resort: ResortRow | null
  listingsRelinked: number
  aliasRecorded: string | null
}

export interface ResortRow extends ResortOption {
  slug: string
  is_active: boolean
  listing_count: number
  alias_count: number
  created_at: string
}

export interface SubmissionRow {
  id: string
  slug: string
  raw_name: string
  region: string | null
  status: string
  first_seen_at: string
  last_seen_at: string
  submitted_by_email: string | null
  listing_count: number
}

/**
 * Approve a submission.
 *
 * The admin supplies the CANONICAL name, which need not match what the host typed —
 * that is how 'amouge' becomes 'Amouage'. If a resort with that name already exists
 * (or `mergeIntoId` is given), the submission merges into it rather than creating a
 * duplicate.
 *
 * Three things happen atomically:
 *   1. The resort exists (created or reused).
 *   2. The submitted slug is recorded as an ALIAS, so the next host to type the
 *      misspelling auto-links instead of re-queueing it.
 *   3. Every listing carrying that free text is relinked and takes the resort's region.
 */
export async function approveResortSubmission(input: {
  submissionId: string
  canonicalName: string
  region: string
  mergeIntoId?: string | null
  actor: string | null
}): Promise<ApproveResult> {
  if (!isUuid(input.submissionId)) throw new Error('Invalid submission')
  const name = normalizeResortName(input.canonicalName)
  if (!name) throw new Error('A resort name is required')
  if (!isRegion(input.region)) throw new Error('Pick a valid region')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: subs } = await client.query<{ slug: string; raw_name: string }>(
      `SELECT slug, raw_name FROM resort_submissions WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [input.submissionId]
    )
    if (!subs[0]) throw new Error('That submission has already been resolved')
    const sub = subs[0]

    // 1. Resolve the target resort — merge into an existing one, or create it.
    let resortId = input.mergeIntoId && isUuid(input.mergeIntoId) ? input.mergeIntoId : null
    if (!resortId) {
      const canonicalSlug = resortSlug(name)
      const { rows: found } = await client.query<{ id: string }>(`SELECT id FROM resorts WHERE slug = $1`, [canonicalSlug])
      if (found[0]) {
        resortId = found[0].id
      } else {
        const { rows: made } = await client.query<{ id: string }>(
          `INSERT INTO resorts (name, slug, region, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
          [name, canonicalSlug, input.region, input.actor]
        )
        resortId = made[0].id
      }
    }

    // 2. Remember the misspelling forever.
    let aliasRecorded: string | null = null
    if (resortSlug(name) !== sub.slug) {
      await client.query(
        `INSERT INTO resort_aliases (slug, resort_id, label, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING`,
        [sub.slug, resortId, sub.raw_name, input.actor]
      )
      aliasRecorded = sub.slug
    }

    // 3. Relink every listing that typed this name — including other spellings that
    //    normalize to the same slug, which is what "merge the two Amouages" means.
    const { rowCount } = await client.query(
      `UPDATE listings l SET resort_id = $1, resort_name = NULL,
              region = (SELECT region FROM resorts WHERE id = $1)
        WHERE l.resort_id IS NULL AND l.resort_name IS NOT NULL
          AND lower(btrim(l.resort_name)) IN (lower(btrim($2)), lower(btrim($3)))`,
      [resortId, sub.raw_name, name]
    )

    await client.query(
      `UPDATE resort_submissions
          SET status = 'approved', resolved_at = now(), resolved_by = $2, resort_id = $3
        WHERE id = $1`,
      [input.submissionId, input.actor, resortId]
    )
    await client.query('COMMIT')

    return {
      resort: (await listResorts()).find((r) => r.id === resortId) ?? null,
      listingsRelinked: rowCount ?? 0,
      aliasRecorded,
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Assign a free-text name straight to an existing resort, without a submission —
 *  the unassigned-listings sweep. Records the alias so it sticks. */
export async function assignFreeTextToResort(
  rawName: string,
  resortId: string,
  actor: string | null
): Promise<number> {
  if (!isUuid(resortId)) throw new Error('Invalid resort')
  const name = normalizeResortName(rawName)
  if (!name) throw new Error('Nothing to assign')

  await pool.query(
    `INSERT INTO resort_aliases (slug, resort_id, label, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE SET resort_id = EXCLUDED.resort_id`,
    [resortSlug(name), resortId, name, actor]
  )
  const { rowCount } = await pool.query(
    `UPDATE listings SET resort_id = $2, resort_name = NULL,
            region = (SELECT region FROM resorts WHERE id = $2)
      WHERE resort_id IS NULL AND resort_name IS NOT NULL
        AND lower(btrim(resort_name)) = lower(btrim($1))`,
    [name, resortId]
  )
  return rowCount ?? 0
}

export async function createResort(input: {
  name: string
  region: string
  createdBy: string | null
}): Promise<ResortRow | null> {
  const name = normalizeResortName(input.name)
  if (!name) throw new Error('A resort name is required')
  if (!isRegion(input.region)) throw new Error('Pick a valid region')
  const slug = resortSlug(name)
  if (!slug) throw new Error('That name has no usable characters')

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO resorts (name, slug, region, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [name, slug, input.region, input.createdBy]
  )
  if (!rows[0]) throw new Error(`"${name}" already exists in the catalog`)
  return (await listResorts()).find((r) => r.id === rows[0].id) ?? null
}

/** The pending queue, newest activity first. */
export async function listResortSubmissions(status = 'pending'): Promise<SubmissionRow[]> {
  const { rows } = await pool.query<SubmissionRow>(
    `SELECT s.id, s.slug, s.raw_name, s.region, s.status, s.first_seen_at, s.last_seen_at,
            u.email AS submitted_by_email,
            (SELECT count(*)::int FROM listings l
              WHERE l.resort_id IS NULL AND l.resort_name IS NOT NULL
                AND lower(btrim(l.resort_name)) = lower(btrim(s.raw_name))) AS listing_count
       FROM resort_submissions s LEFT JOIN users u ON u.id = s.submitted_by
      WHERE s.status = $1
      ORDER BY s.last_seen_at DESC`,
    [status]
  )
  return rows
}

/** The catalog table, with the numbers an admin decides on. */
export async function listResorts(): Promise<ResortRow[]> {
  const { rows } = await pool.query<ResortRow>(
    `SELECT r.id, r.name, r.slug, r.region, r.is_active, r.created_at,
            (SELECT count(*)::int FROM listings l WHERE l.resort_id = r.id)        AS listing_count,
            (SELECT count(*)::int FROM resort_aliases a WHERE a.resort_id = r.id)  AS alias_count
       FROM resorts r
      ORDER BY r.region, r.name`
  )
  return rows
}

/** Free-text names on listings that have no pending submission — the long tail an
 *  admin sweeps up. Grouped by the exact text so near-duplicates are visible. */
export async function listUnassignedResortNames(): Promise<Array<{ name: string; listing_count: number }>> {
  const { rows } = await pool.query(
    `SELECT btrim(l.resort_name) AS name, count(*)::int AS listing_count
       FROM listings l
      WHERE l.resort_id IS NULL AND l.resort_name IS NOT NULL AND btrim(l.resort_name) <> ''
      GROUP BY 1 ORDER BY 2 DESC, 1`
  )
  return rows as Array<{ name: string; listing_count: number }>
}

/** Which listings a merge would relink, so the admin sees the blast radius first. */
export async function previewResortMerge(rawName: string): Promise<Array<{ id: string; title: string; resort_name: string }>> {
  const { rows } = await pool.query(
    `SELECT id, title, resort_name FROM listings
      WHERE resort_id IS NULL AND resort_name IS NOT NULL
        AND lower(btrim(resort_name)) = lower(btrim($1))
      ORDER BY title LIMIT 200`,
    [rawName]
  )
  return rows as Array<{ id: string; title: string; resort_name: string }>
}

/** Dismiss a submission. The listings keep their free text and keep showing it to
 *  guests — rejecting a name is not a reason to blank a host's listing. */
export async function rejectResortSubmission(
  submissionId: string,
  reason: string | null,
  actor: string | null
): Promise<boolean> {
  if (!isUuid(submissionId)) return false
  const { rowCount } = await pool.query(
    `UPDATE resort_submissions
        SET status = 'rejected', resolved_at = now(), resolved_by = $2, reject_reason = $3
      WHERE id = $1 AND status = 'pending'`,
    [submissionId, actor, reason?.trim()?.slice(0, 300) || null]
  )
  return (rowCount ?? 0) > 0
}

/**
 * Resolve the resort on ONE listing, at approval time.
 *
 * This is the /ops listing-approval popup's action. It differs from
 * approveResortSubmission on purpose: that one is a bulk decision taken from the
 * queue and relinks every listing sharing the name, whereas this one is scoped to
 * the single listing the admin is looking at — other listings using the same text
 * are deliberately left for the queue.
 *
 * An alias is still recorded for 'new' and 'match', because an alias only affects
 * what FUTURE hosts type; it never touches an existing listing. That is what stops
 * the same spelling coming back for review again and again.
 *
 * Modes:
 *   'new'   — create (or reuse) a resort under `name`, which the admin may have
 *             corrected from the host's spelling, and point this listing at it.
 *   'match' — point this listing at an existing resort the host missed.
 *   'keep'  — leave the typed text alone; it stays visible to guests and stays in
 *             the queue.
 */
export async function resolveListingResort(input: {
  listingId: string
  mode: 'new' | 'match' | 'keep'
  /** Canonical name for 'new'. Prefilled from the host's text in the UI. */
  name?: string | null
  /** Region for 'new'. Defaults to the listing's own region. */
  region?: string | null
  /** Target for 'match'. */
  resortId?: string | null
  actor: string | null
}): Promise<{ resortId: string | null; resortName: string | null; aliasRecorded: string | null }> {
  if (!isUuid(input.listingId)) throw new Error('Invalid listing')

  const { rows: listings } = await pool.query<{ resort_name: string | null; region: string | null }>(
    `SELECT resort_name, region FROM listings WHERE id = $1`,
    [input.listingId]
  )
  if (!listings[0]) throw new Error('Listing not found')
  const typed = normalizeResortName(listings[0].resort_name)

  // Nothing to resolve, or the admin chose to keep the host's wording.
  if (input.mode === 'keep' || !typed) {
    return { resortId: null, resortName: typed, aliasRecorded: null }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let resortId: string

    if (input.mode === 'match') {
      if (!input.resortId || !isUuid(input.resortId)) throw new Error('Pick a resort to match')
      const { rows } = await client.query(`SELECT 1 FROM resorts WHERE id = $1`, [input.resortId])
      if (!rows[0]) throw new Error('That resort no longer exists')
      resortId = input.resortId
    } else {
      const name = normalizeResortName(input.name)
      if (!name) throw new Error('A resort name is required')
      const region = isRegion(input.region) ? input.region : listings[0].region
      if (!isRegion(region)) throw new Error('Pick a region for the new resort')

      const slug = resortSlug(name)
      if (!slug) throw new Error('That name has no usable characters')
      // Reuse rather than duplicate if the admin types a name that already exists.
      const { rows: found } = await client.query<{ id: string }>(`SELECT id FROM resorts WHERE slug = $1`, [slug])
      if (found[0]) {
        resortId = found[0].id
      } else {
        const { rows: made } = await client.query<{ id: string }>(
          `INSERT INTO resorts (name, slug, region, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
          [name, slug, region, input.actor]
        )
        resortId = made[0].id
      }
    }

    // Remember the host's spelling so the next one to type it links automatically.
    let aliasRecorded: string | null = null
    const typedSlug = resortSlug(typed)
    const { rows: target } = await client.query<{ slug: string }>(`SELECT slug FROM resorts WHERE id = $1`, [resortId])
    if (typedSlug && target[0] && typedSlug !== target[0].slug) {
      await client.query(
        `INSERT INTO resort_aliases (slug, resort_id, label, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING`,
        [typedSlug, resortId, typed, input.actor]
      )
      aliasRecorded = typedSlug
    }

    // THIS listing only — the region follows the resort, as everywhere else.
    await client.query(
      `UPDATE listings SET resort_id = $1, resort_name = NULL,
              region = (SELECT region FROM resorts WHERE id = $1)
        WHERE id = $2`,
      [resortId, input.listingId]
    )

    // If a pending submission exists for this exact spelling and no other listing
    // still uses it, it is now moot — close it out rather than leave a dead row.
    await client.query(
      `UPDATE resort_submissions s SET status = 'approved', resolved_at = now(), resolved_by = $2, resort_id = $3
        WHERE s.slug = $1 AND s.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM listings l
             WHERE l.resort_id IS NULL AND l.resort_name IS NOT NULL
               AND lower(btrim(l.resort_name)) = lower(btrim($4)))`,
      [typedSlug, input.actor, resortId, typed]
    )

    await client.query('COMMIT')
    return { resortId, resortName: null, aliasRecorded }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Rename / move / retire. Renaming keeps the old slug as an ALIAS, so listings
 *  and hosts that used the previous spelling keep resolving to this resort. */
export async function updateResort(
  id: string,
  fields: { name?: string; region?: string; isActive?: boolean },
  actor: string | null
): Promise<ResortRow | null> {
  if (!isUuid(id)) return null
  const { rows: existing } = await pool.query<{ name: string; slug: string }>(
    `SELECT name, slug FROM resorts WHERE id = $1`,
    [id]
  )
  if (!existing[0]) return null

  let name: string | null = null
  let slug: string | null = null
  if (fields.name !== undefined) {
    name = normalizeResortName(fields.name)
    if (!name) throw new Error('A resort name is required')
    slug = resortSlug(name)
    if (!slug) throw new Error('That name has no usable characters')
    const { rows: clash } = await pool.query(`SELECT 1 FROM resorts WHERE slug = $1 AND id <> $2`, [slug, id])
    if (clash.length) throw new Error(`Another resort already uses the name "${name}"`)
  }
  if (fields.region !== undefined && !isRegion(fields.region)) throw new Error('Pick a valid region')

  await pool.query(
    `UPDATE resorts SET name = COALESCE($2, name), slug = COALESCE($3, slug),
            region = COALESCE($4, region), is_active = COALESCE($5, is_active), updated_at = now()
      WHERE id = $1`,
    [id, name, slug, fields.region ?? null, fields.isActive === undefined ? null : fields.isActive]
  )

  // Keep the old spelling working.
  if (slug && slug !== existing[0].slug) {
    await pool.query(
      `INSERT INTO resort_aliases (slug, resort_id, label, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING`,
      [existing[0].slug, id, existing[0].name, actor]
    )
  }
  // A region change follows through to the listings, since region is derived.
  if (fields.region !== undefined) {
    await pool.query(`UPDATE listings SET region = $2 WHERE resort_id = $1`, [id, fields.region])
  }
  return (await listResorts()).find((r) => r.id === id) ?? null
}

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

