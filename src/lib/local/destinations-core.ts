// Destinations — the two-level browse tree behind the explore "region rail":
// a REGION (North Coast, Ain Sokhna, …) and, under it, its SUB-AREAS (Marassi,
// Azha, …). Two levels, never more.
//
// There is no destinations table. A region is the `listings.region` text column
// (closed set: REGION_VALUES in resort-core.ts) and a sub-area IS a row of the
// existing `resorts` catalog, which already belongs to exactly one region and is
// already what the host picks. scripts/migrate-destinations.mjs seeds the catalog
// with the business owner's list and adds the display columns (name_ar,
// km_marker, location_note, sort_order).
//
// Pure and import-free for the same reason resort-core.ts is: `node --test` loads
// it directly. The SQL that feeds buildDestinationTree() lives in db.ts.

/** Display metadata for each region, in RAIL ORDER. `name` is the stored value
 *  (must match REGION_VALUES exactly — a unit test guards it); `slug` is the URL
 *  form; `icon` is a semantic key each client maps to its own icon set (Lucide
 *  on web, SF Symbols on iOS, Material on Android), so no client hardcodes the
 *  region list itself. */
export const REGION_META = [
  { name: 'North Coast', slug: 'north-coast', name_ar: 'الساحل الشمالي', icon: 'waves' },
  { name: 'Ain Sokhna', slug: 'ain-sokhna', name_ar: 'العين السخنة', icon: 'sunrise' },
  { name: 'Ras Sudr', slug: 'ras-sudr', name_ar: 'رأس سدر', icon: 'wind' },
  { name: 'Cairo', slug: 'cairo', name_ar: 'القاهرة', icon: 'landmark' },
  { name: 'New Cairo', slug: 'new-cairo', name_ar: 'القاهرة الجديدة', icon: 'building' },
  { name: 'Giza', slug: 'giza', name_ar: 'الجيزة', icon: 'pyramid' },
  { name: 'Alexandria', slug: 'alexandria', name_ar: 'الإسكندرية', icon: 'anchor' },
  { name: 'Marsa Matrouh', slug: 'marsa-matrouh', name_ar: 'مطروح', icon: 'umbrella' },
  { name: 'Hurghada', slug: 'hurghada', name_ar: 'الغردقة', icon: 'fish' },
  { name: 'El Gouna', slug: 'el-gouna', name_ar: 'الجونة', icon: 'sailboat' },
  { name: 'Sharm El Sheikh', slug: 'sharm-el-sheikh', name_ar: 'شرم الشيخ', icon: 'shell' },
  { name: 'Dahab', slug: 'dahab', name_ar: 'دهب', icon: 'mountain' },
] as const

export type RegionMeta = (typeof REGION_META)[number]

/** A region by its stored name OR its slug, case-insensitively. Clients send the
 *  name today (`?region=North Coast`); a shareable URL would send the slug. */
export function findRegion(value: unknown): RegionMeta | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (!v) return null
  return REGION_META.find((r) => r.name.toLowerCase() === v || r.slug === v) ?? null
}

/** One resort row as db.ts reads it for the tree. */
export interface SubAreaRow {
  id: string
  slug: string
  name: string
  name_ar: string | null
  region: string
  km_marker: number | string | null
  location_note: string | null
  sort_order: number | null
  /** Published listings pointing at this resort. */
  count: number
}

export interface DestinationSubArea {
  id: string
  slug: string
  name: string
  name_ar: string | null
  km_marker: number | null
  location_note: string | null
  count: number
}

export interface DestinationRegion {
  name: string
  slug: string
  name_ar: string
  icon: string
  count: number
  sub_areas: DestinationSubArea[]
}

/** Postgres NUMERIC arrives as a string; anything unparseable is "no marker". */
function km(value: number | string | null): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Sub-area order inside a region: the admin's sort_order first, then "follow the
 * road" (km marker ascending, unmarked after), then name. sort_order wins so an
 * admin can always override the coast order.
 */
export function compareSubAreas(a: SubAreaRow, b: SubAreaRow): number {
  const so = (a.sort_order ?? 0) - (b.sort_order ?? 0)
  if (so !== 0) return so
  const ka = km(a.km_marker)
  const kb = km(b.km_marker)
  if (ka !== kb) {
    if (ka === null) return 1
    if (kb === null) return -1
    return ka - kb
  }
  return a.name.localeCompare(b.name)
}

/**
 * The catch-all chip. A location a host types that isn't in the catalog is NOT
 * mapped into a new sub-area (that grew the chip row without bound) — the listing
 * keeps the host's text for guests and lands here. Every listing in a region with
 * no catalog resort counts, typed or blank. The feed reads `?area=other` as
 * `resort_id IS NULL`; no catalog resort may use this slug.
 */
export const OTHER_AREA_SLUG = 'other'

/** True when an `area=` value means the catch-all rather than a catalog slug. */
export function isOtherArea(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === OTHER_AREA_SLUG
}

/**
 * Assemble the tree every client renders. Always returns all REGION_META regions
 * in rail order (count 0 when empty) so the rail never reshuffles. A region's
 * count is its OWN listing count (a listing with no sub-area still counts), so it
 * is not the sum of its chips. Sub-area rows for an unknown region are dropped.
 *
 * `otherCounts` (published listings with no catalog resort, per region) adds the
 * "Other" chip LAST — only when non-zero, and only beside real chips, since a
 * region with no catalog sub-areas has no chip row to put it in.
 */
export function buildDestinationTree(
  regionCounts: ReadonlyMap<string, number>,
  subAreas: readonly SubAreaRow[],
  otherCounts: ReadonlyMap<string, number> = new Map()
): DestinationRegion[] {
  return REGION_META.map((r) => {
    const chips: DestinationSubArea[] = subAreas
      .filter((s) => s.region === r.name && s.slug !== OTHER_AREA_SLUG)
      .slice()
      .sort(compareSubAreas)
      .map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        name_ar: s.name_ar ?? null,
        km_marker: km(s.km_marker),
        location_note: s.location_note ?? null,
        count: Number(s.count) || 0,
      }))
    const other = Number(otherCounts.get(r.name)) || 0
    if (chips.length > 0 && other > 0) {
      chips.push({
        id: `${OTHER_AREA_SLUG}-${r.slug}`,
        slug: OTHER_AREA_SLUG,
        name: 'Other',
        name_ar: 'أخرى',
        km_marker: null,
        location_note: null,
        count: other,
      })
    }
    return { name: r.name, slug: r.slug, name_ar: r.name_ar, icon: r.icon, count: regionCounts.get(r.name) ?? 0, sub_areas: chips }
  })
}
