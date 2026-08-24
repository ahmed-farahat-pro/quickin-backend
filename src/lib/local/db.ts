import { pool } from './pool'
import { buildUserListWhere, hidesListings, orderBySql } from './user-admin-core'
import type { UserListFilter, AccountStatus } from './user-admin-core'
import { normalizeStatus } from './user-admin-core'
import { countOpenDisputes, oldestOpenDisputeAt } from './disputes'
import { countFlaggedUsers, oldestFlaggedAt } from './moderation'
import { countPendingIdChanges, oldestPendingIdChangeAt } from './id-changes'
import { idChangeColumnFor, idColumnFor, statusForAction } from './document-core'
import { canPay, outcomeFor, PaymentProofError } from './payment-flow-core'
import type { PaymentReviewAction } from './payment-flow-core'
import { branchLimit, wantsKind } from './activity-core'
import type { ActivityFilter, AuditFilter } from './activity-core'
import { PAID_SQL } from './analytics-core'
import { buildSeries, bucketsFor, METRICS, publicMetrics, RANGES, windowFor } from './overview-trends-core'
import type { MetricId, MetricSpec, RangeId, SeriesPoint, TrendPayload } from './overview-trends-core'
import type { DocumentKind, VerificationAction, VerificationFilter } from './document-core'

import {
  refundPercentFor, refundAmountFor, isCancellable, normalizePolicy,
  CANCELLATION_POLICIES,
  type CancellationPolicy,
} from './cancellation-core'
import { resolveResortSelection } from './resorts'
import { normalizeResortName, validateResortName } from './resort-core'
import { storeListingPhotos } from './blob-store'
import type { PoolClient } from 'pg'
import { randomInt } from 'node:crypto'
import { createNotification } from './notifications'
import { sendNotificationEmail } from './mailer'
import { sendPush } from './push'
import { isContactBlockedError } from './contentguard'
import { guardContent, guardSplitContent } from './moderation'
import { PAYMENT_SETTING_KEYS, normalizePaymentMethod, rowsToPaymentConfig } from './payment-config-core'
import type { PaymentConfig } from './payment-config-core'
import { rowToPayoutMethod } from './payout-method-core'
import { needsIdentityDocuments, normalizeVerificationStatus, revokesListingPrivileges } from './host-verification-core'
import type { PayoutMethodRecord, PayoutMethodView } from './payout-method-core'
import {
  COMMISSION_RATE_KEY,
  COMMISSION_RATE_SQL,
  parseRate,
  rateToStored,
  roundUpToStep,
  sqlWithCommission,
  bookingCommissionSql } from './commission-core'
import {
  DatePriceError,
  applyBlockChange,
  assertWithinWindow,
  blockRewriteWindow,
  checkDayPrice,
  dayPriceMessage,
  daysBetween,
  isIsoDate,
  sqlWithDatePrice,
  stayDiscountFactorSql,
  perNightSeasonalSql,
} from './date-pricing-core'
import type { BlockSpan, DayStatus, PriceSource } from './date-pricing-core'
import { sqlRankingOrderBy } from './ranking-core'
import { listingRejectionMessage, normalizeListingReviewNote } from './listing-review-note-core'
import { normalizeListingTitle, validateListingTitle } from './listing-title-policy'
import {
  checkListingCompleteness,
  checkListingEdit,
  listingCompletenessProblemMessage,
  MIN_LISTING_PHOTOS,
} from './listing-completeness-policy'
import type { ListingCurrentState } from './listing-completeness-policy'
import { checkOwnershipDoc, ownershipDocProblemMessage } from './ownership-doc-core'

export type { PaymentConfig }

const WEB_URL = process.env.WEB_URL || 'https://quickin-frontend.vercel.app'

// Look up a user's email for transactional notifications (best-effort).
async function userEmail(id: string): Promise<string | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null
  try {
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [id])
    return rows[0]?.email ?? null
  } catch {
    return null
  }
}

// Data access via node-postgres (parameterized queries). Works locally and on
// Vercel/Neon. No Supabase, no psql CLI.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export interface ListingImage {
  /** listing_images.id — what the photo add/delete/reorder endpoints address. */
  id: string
  url: string
  order: number
}

export interface Listing {
  id: string
  title: string
  description: string | null
  location: string | null
  country: string | null
  /** Guest projection: commission-inclusive. Host projection: the host's raw
   *  price. See LISTING_COLS vs LISTING_COLS_HOST. */
  price_per_night: number
  weekend_price: number | null
  monthly_prices: Record<string, number>
  /** The commission rate these prices were projected with (0.1 = 10%). */
  commission_rate?: number
  /** Host projection only — what a guest is quoted for the same nights. */
  guest_price_per_night?: number
  guest_weekend_price?: number | null
  guest_monthly_prices?: Record<string, number>
  currency: string
  bedrooms: number | null
  beds: number | null
  bathrooms: number | null
  max_guests: number | null
  property_type: string | null
  region: string | null
  /** The catalog resort this listing belongs to, or null when the host typed
   *  their own (see `resort`). Region is derived from it. */
  resort_id?: string | null
  /** Display name: the catalog resort's name, or the host's free text.
   *  Free text still shows to guests as typed while it awaits moderation. */
  resort?: string | null
  cancellation_policy: string
  approval_status: string
  /** The operator's reason for rejecting this listing, or null when they gave none
   *  (the note is optional) — see listing-review-note-core.ts. HOST PROJECTION ONLY:
   *  staff-authored text about the host, never part of a guest read. Cleared when the
   *  listing goes back into the queue, so it always describes the CURRENT rejection.
   *  The mobile host dashboards render it under the "Rejected" badge. */
  review_note?: string | null
  weekly_discount: number
  monthly_discount: number
  host_id: string | null
  host_name: string | null
  host_verified: boolean
  is_guest_favorite: boolean
  listing_code: string | null
  lat: number | null
  lng: number | null
  rating: number
  review_count: number
  created_at: string | null
  listing_images: ListingImage[]
}

// The coarse, host-picked areas QuickIn covers. The host chooses one of these
// first; search can filter by it (chips) and it's matched by free-text too.
export const REGIONS = ['North Coast', 'Ain Sokhna', 'El Gouna', 'Cairo'] as const
export type Region = (typeof REGIONS)[number]

export type ListingSort = 'recommended' | 'price_asc' | 'price_desc' | 'newest'

export interface SearchFilters {
  /** Free text — matched across title, location, region and country. */
  q?: string
  /** Back-compat alias for q (the explore bar still sends `location`). */
  location?: string
  /** Exact region chip (one of REGIONS). */
  region?: string
  /** All published listings by a given host (for "more from this host"). */
  host?: string
  guests?: number
  checkIn?: string
  checkOut?: string
  minPrice?: number
  maxPrice?: number
  propertyType?: string
  /** Listings must have ALL of these amenities. */
  amenities?: string[]
  /** Map viewport bounds for "search this area". */
  bbox?: { minLat: number; minLng: number; maxLat: number; maxLng: number }
  sort?: ListingSort
}

export interface Booking {
  id: string
  listing_id: string
  user_id: string
  check_in: string
  check_out: string
  guests: number
  /** COMMISSION-INCLUSIVE — what the guest owes. The host's raw stay total is
   *  what the column stores; it surfaces only as `host_payout`, below. */
  total_price: number
  /** The rate this booking was priced at, snapshotted when it was taken. */
  commission_rate?: number | null
  /** Host-only readers (getHostBookings) — the raw amount the host is owed. */
  host_payout?: number
  status: string
  created_at: string
  title: string
  location: string | null
  region: string | null
  image: string | null
  reservation_code: string | null
  host_id: string | null
  payment_status: string
  paid_at: string | null
  /** 'instapay' once a transfer screenshot is submitted (else null / legacy value). */
  payment_method: string | null
  /** Latest payment_proofs row status: submitted | approved | rejected | disputed (null = no proof). */
  payment_proof_status: string | null
  payment_submitted_at: string | null
  payment_reject_reason: string | null
  host_notes: string | null
  amenities: string[]
  cancellation_policy: string
  cancelled_at: string | null
  refund_percent: number | null
  promo_code: string | null
  promo_discount: number | null
}

// ---- Price projection (platform commission) ---------------------------------
// A listing carries ONE price in the database: the raw amount its host set and
// is paid. What a guest is quoted is that raw price marked up by the platform
// commission (see commission-core.ts). Which of the two lands in
// `price_per_night` is decided HERE, by whether the caller asked for the guest
// projection or the host one — so no read path can forget to apply the markup,
// and no guest response can leak the host's raw price.
//
// Guest reads  → price_per_night = marked up. No raw fields at all.
// Host reads   → price_per_night = raw (this is the number the host edits and
//                PATCHes back, so a load→save round trip must not inflate it),
//                plus read-only guest_* companions for "guests pay X".

/**
 * The seasonal rungs of the ladder, below the host's calendar: weekend price
 * (Fri/Sat in Egypt) → that month's override → base. Expects `l` (listings) and
 * `d` (a generate_series date) in scope.
 */
const PER_NIGHT_SEASONAL_SQL = perNightSeasonalSql('d')

/**
 * The host's RAW price for one night `d` of a stay — the WHOLE ladder:
 *
 *     host calendar (listing_date_prices) → weekend → month → base
 *
 * A day the host pinned on their calendar beats every seasonal rule, which is
 * the entire point of the feature: "this Thursday is Eid, charge 6,000" has to
 * survive a weekend rate and a month rate that both disagree.
 *
 * Wrap it in sqlWithCommission() for the guest-facing figure. This is the SQL
 * twin of resolveNightPrice() in date-pricing-core.ts — the two must answer the
 * same number, or a client's preview and the server's charge would disagree.
 */
const PER_NIGHT_RAW_SQL = sqlWithDatePrice('d', PER_NIGHT_SEASONAL_SQL)

/** Mark up every entry of the monthly_prices jsonb map, dropping junk values. */
const MONTHLY_GUEST_SQL = `COALESCE((
    SELECT jsonb_object_agg(mp.k, ${sqlWithCommission('mp.v::numeric')})
      FROM jsonb_each_text(COALESCE(l.monthly_prices, '{}'::jsonb)) AS mp(k, v)
     WHERE mp.v ~ '^[0-9.]+$'
  ), '{}'::jsonb)`

const GUEST_PRICE_COLS = `
  ${sqlWithCommission('l.price_per_night')}::float8 AS price_per_night,
  ${sqlWithCommission('l.weekend_price')}::float8 AS weekend_price,
  ${MONTHLY_GUEST_SQL} AS monthly_prices,
  ${COMMISSION_RATE_SQL}::float8 AS commission_rate,`

const HOST_PRICE_COLS = `
  l.price_per_night::float8 AS price_per_night,
  l.weekend_price::float8 AS weekend_price,
  COALESCE(l.monthly_prices, '{}'::jsonb) AS monthly_prices,
  ${sqlWithCommission('l.price_per_night')}::float8 AS guest_price_per_night,
  ${sqlWithCommission('l.weekend_price')}::float8 AS guest_weekend_price,
  ${MONTHLY_GUEST_SQL} AS guest_monthly_prices,
  ${COMMISSION_RATE_SQL}::float8 AS commission_rate,`

/** Everything that isn't a price — identical in both projections. */
const LISTING_COMMON_COLS = `
  l.currency,
  l.bedrooms, l.beds, l.bathrooms, l.max_guests, l.property_type, l.region,
  l.resort_id, COALESCE((SELECT name FROM resorts WHERE id = l.resort_id), l.resort_name) AS resort,
  COALESCE(l.cancellation_policy, 'moderate') AS cancellation_policy,
  COALESCE(l.approval_status, 'approved') AS approval_status,
  COALESCE(l.weekly_discount, 0) AS weekly_discount,
  COALESCE(l.monthly_discount, 0) AS monthly_discount,
  l.host_id, (SELECT u.full_name FROM users u WHERE u.id = l.host_id) AS host_name,
  COALESCE((SELECT u.verification_status = 'verified' FROM users u WHERE u.id = l.host_id), false) AS host_verified,
  l.is_guest_favorite, l.listing_code, l.lat::float8 AS lat, l.lng::float8 AS lng,
  to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  COALESCE(l.amenities, '{}') AS amenities,
  COALESCE((SELECT round(avg(rv.rating)::numeric, 2) FROM reviews rv WHERE rv.listing_id = l.id), 0)::float8 AS rating,
  COALESCE((SELECT count(*) FROM reviews rv WHERE rv.listing_id = l.id), 0)::int AS review_count,
  COALESCE(
    (SELECT json_agg(json_build_object('id', li.id, 'url', li.url, 'order', li."order") ORDER BY li."order")
     FROM listing_images li WHERE li.listing_id = l.id), '[]'
  ) AS listing_images
`

/** Guest projection — prices include the platform commission. */
export const LISTING_COLS = `
  l.id, l.title, l.description, l.location, l.country,
  ${GUEST_PRICE_COLS}
  ${LISTING_COMMON_COLS}
`

/** Host/staff projection — prices are the host's raw amounts, with guest_*
 *  companions showing what a guest is quoted. Never serve this to a guest. */
export const LISTING_COLS_HOST = `
  l.id, l.title, l.description, l.location, l.country,
  ${HOST_PRICE_COLS}
  ${LISTING_COMMON_COLS},
  -- Deliberately NOT in LISTING_COMMON_COLS: the rejection note is staff-authored
  -- text about this host's listing and belongs to the host alone. Adding it to the
  -- shared block would publish it on every guest read of a listing.
  l.review_note
`

export async function getListings(filters: SearchFilters = {}): Promise<Listing[]> {
  const where: string[] = ['l.is_published = true']
  const params: unknown[] = []

  // Free text: match the term across title, location, region and country, so
  // "north coast" surfaces a whole area AND a property name still finds it.
  const q = (filters.q ?? filters.location ?? '').trim()
  if (q) {
    params.push('%' + q + '%')
    const p = params.length
    where.push(
      `(l.title ILIKE $${p} OR l.location ILIKE $${p} OR l.region ILIKE $${p} OR l.country ILIKE $${p})`
    )
  }
  // Exact region chip.
  if (filters.region && filters.region.trim()) {
    params.push(filters.region.trim())
    where.push(`l.region ILIKE $${params.length}`)
  }
  // A specific host's listings.
  if (filters.host && /^[0-9a-fA-F-]{36}$/.test(filters.host)) {
    params.push(filters.host)
    where.push(`l.host_id = $${params.length}`)
  }
  if (filters.guests && Number.isFinite(filters.guests) && filters.guests > 0) {
    params.push(Math.floor(filters.guests))
    where.push(`COALESCE(l.max_guests, 0) >= $${params.length}`)
  }
  // Price filters compare against the COMMISSION-INCLUSIVE price — a guest who
  // drags the slider to 3,000 means the number they see on the card, not the
  // host's raw price underneath it.
  if (Number.isFinite(filters.minPrice as number) && (filters.minPrice as number) >= 0) {
    params.push(filters.minPrice)
    where.push(`${sqlWithCommission('l.price_per_night')} >= $${params.length}`)
  }
  if (Number.isFinite(filters.maxPrice as number) && (filters.maxPrice as number) > 0) {
    params.push(filters.maxPrice)
    where.push(`${sqlWithCommission('l.price_per_night')} <= $${params.length}`)
  }
  if (filters.propertyType && filters.propertyType.trim()) {
    params.push(filters.propertyType.trim())
    where.push(`l.property_type ILIKE $${params.length}`)
  }
  // Has ALL the requested amenities (text[] contains).
  if (Array.isArray(filters.amenities) && filters.amenities.length > 0) {
    params.push(filters.amenities)
    where.push(`COALESCE(l.amenities, '{}') @> $${params.length}::text[]`)
  }
  // Map viewport bounds ("search this area"): keep listings inside the box.
  if (filters.bbox) {
    const { minLat, minLng, maxLat, maxLng } = filters.bbox
    if ([minLat, minLng, maxLat, maxLng].every((n) => Number.isFinite(n))) {
      params.push(minLat); const a = params.length
      params.push(maxLat); const b = params.length
      params.push(minLng); const c = params.length
      params.push(maxLng); const d = params.length
      where.push(`l.lat BETWEEN $${a} AND $${b} AND l.lng BETWEEN $${c} AND $${d}`)
    }
  }
  if (filters.checkIn && filters.checkOut && isDate(filters.checkIn) && isDate(filters.checkOut)) {
    params.push(filters.checkOut)
    const a = params.length
    params.push(filters.checkIn)
    const b = params.length
    where.push(`NOT EXISTS (
      SELECT 1 FROM bookings bk
      WHERE bk.listing_id = l.id AND bk.status <> 'cancelled'
        AND bk.check_in < $${a} AND bk.check_out > $${b}
    ) AND NOT EXISTS (
      SELECT 1 FROM listing_blocked_dates bd
      WHERE bd.listing_id = l.id
        AND bd.start_date < $${a} AND bd.end_date > $${b}
    )`)
  }

  // Sorting stays on the raw column: the markup is a monotone non-decreasing
  // transform of it, so the guest-visible order is identical and this keeps any
  // index on price_per_night usable.
  //
  // `recommended` — the default, so this is what most guests actually see — is
  // the performance ranking: guest ratings (shrunk, so one 5★ can't top a body
  // of them) plus COMPLETED stays (never a cancellation), both recency-weighted.
  // See ranking-core.ts. It replaced `is_guest_favorite DESC, created_at DESC`,
  // which is now folded in as a small bonus and the tie-break.
  const ORDER: Record<string, string> = {
    price_asc: 'l.price_per_night ASC, l.created_at DESC',
    price_desc: 'l.price_per_night DESC, l.created_at DESC',
    newest: 'l.created_at DESC',
    recommended: sqlRankingOrderBy('l'),
  }
  const orderBy = ORDER[filters.sort ?? 'recommended'] ?? ORDER.recommended

  const { rows } = await pool.query(
    `SELECT ${LISTING_COLS} FROM listings l
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}`,
    params
  )
  return rows as Listing[]
}

/** Region facet counts for published listings — powers the search chips. Always
 *  returns the canonical REGIONS (count 0 when none) so the UI is stable. */
export async function getRegionCounts(): Promise<{ region: string; count: number }[]> {
  const { rows } = await pool.query(
    `SELECT region, count(*)::int AS count
       FROM listings
      WHERE is_published = true AND region IS NOT NULL
      GROUP BY region`
  )
  const map = new Map(rows.map((r) => [String(r.region), Number(r.count)]))
  return REGIONS.map((region) => ({ region, count: map.get(region) ?? 0 }))
}

/**
 * One listing. Defaults to the GUEST projection (commission-inclusive prices,
 * no raw host figures). Pass `{ asHost: true }` only when the response goes to
 * the listing's own host or to staff — every write path does, because the host
 * form loads these values and PATCHes them straight back.
 */
export async function getListingById(id: string, opts: { asHost?: boolean } = {}): Promise<Listing | null> {
  if (!isUuid(id)) return null
  const cols = opts.asHost ? LISTING_COLS_HOST : LISTING_COLS
  // Joined host identity: the listing page shows who the guest would be staying
  // with, and without this every client had to make a second call for it.
  const { rows } = await pool.query(
    `SELECT ${cols}, l.host_id, u.full_name AS host_name, u.avatar_url AS host_avatar,
            u.host_type AS host_type, u.company AS host_company
       FROM listings l LEFT JOIN users u ON u.id = l.host_id WHERE l.id = $1`,
    [id]
  )
  return (rows[0] as Listing) ?? null
}

// ---- Availability -----------------------------------------------------------

/** One unavailable span on a listing's calendar. `kind` says why: an active
 *  booking ('booked') or a manual host block ('blocked'). Half-open [start,end). */
export interface UnavailableRange {
  id: string
  start: string
  end: string
  kind: 'booked' | 'blocked'
  note: string | null
}

/** Every span a listing is NOT bookable: non-cancelled bookings + host blocks.
 *  Public (no guest data leaks — only dates). Used to grey out calendar days. */
export async function getListingAvailability(listingId: string): Promise<UnavailableRange[]> {
  if (!isUuid(listingId)) return []
  const { rows } = await pool.query(
    `SELECT id::text AS id,
            to_char(check_in, 'YYYY-MM-DD') AS start,
            to_char(check_out, 'YYYY-MM-DD') AS "end",
            'booked'::text AS kind, NULL::text AS note
       FROM bookings
      WHERE listing_id = $1 AND status <> 'cancelled'
     UNION ALL
     SELECT id::text AS id,
            to_char(start_date, 'YYYY-MM-DD') AS start,
            to_char(end_date, 'YYYY-MM-DD') AS "end",
            'blocked'::text AS kind, note
       FROM listing_blocked_dates
      WHERE listing_id = $1
      ORDER BY start ASC`,
    [listingId]
  )
  return rows as UnavailableRange[]
}

/** Host blocks a date range on their own listing (returns null if not the host
 *  or the listing doesn't exist). Half-open [start,end); end must be after start. */
export async function blockListingDates(
  listingId: string,
  hostUserId: string,
  start: string,
  end: string,
  note: string | null = null
): Promise<UnavailableRange | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  if (!isDate(start) || !isDate(end)) throw new Error('Invalid dates (use YYYY-MM-DD)')
  if (end <= start) throw new Error('End must be after start')
  const owns = await pool.query(`SELECT 1 FROM listings WHERE id = $1 AND host_id = $2`, [listingId, hostUserId])
  if (!owns.rowCount) return null
  const { rows } = await pool.query(
    `INSERT INTO listing_blocked_dates (listing_id, start_date, end_date, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text AS id,
               to_char(start_date, 'YYYY-MM-DD') AS start,
               to_char(end_date, 'YYYY-MM-DD') AS "end",
               'blocked'::text AS kind, note`,
    [listingId, start, end, note]
  )
  return (rows[0] as UnavailableRange) ?? null
}

/** Host removes one of their own blocks. Returns true if a row was deleted. */
export async function unblockListingDates(blockId: string, hostUserId: string): Promise<boolean> {
  if (!isUuid(blockId) || !isUuid(hostUserId)) return false
  const { rowCount } = await pool.query(
    `DELETE FROM listing_blocked_dates b
      USING listings l
      WHERE b.id = $1 AND b.listing_id = l.id AND l.host_id = $2`,
    [blockId, hostUserId]
  )
  return (rowCount ?? 0) > 0
}

// ---- Host calendar (per-date pricing + day-level availability) ---------------
//
// The calendar is the host's day-by-day view of one listing: what each night
// costs, where that price came from, and whether the night is still sellable.
// It reads the SAME ladder the booking charges (PER_NIGHT_RAW_SQL), so the price
// a host sees on a day is exactly what a guest will be quoted for that night.

/** One day on a listing's calendar. */
export interface CalendarDay {
  date: string
  /** Nightly rate for the night starting on `date`. RAW for the host,
   *  commission-inclusive for a public reader — same rule as LISTING_COLS. */
  price: number
  /** What a guest pays for this night. Host reads only; never sent publicly
   *  (there it would just repeat `price`). */
  guest_price?: number
  /** Which rung of the ladder produced `price`. 'custom' = pinned by the host. */
  source: PriceSource
  /** Whether the host may still edit this day. */
  status: DayStatus
  /** The host's note on the block covering this day, when there is one. */
  note?: string | null
}

export interface ListingCalendar {
  listing_id: string
  currency: string
  commission_rate: number
  /** listings.price_per_night, in the same raw/guest terms as `days[].price`. */
  base_price: number
  start: string
  /** Inclusive — the last day in `days`, not a half-open bound. */
  end: string
  days: CalendarDay[]
}

/** True when the host pinned a price on the day `d`. Kept next to the projection
 *  so `source` can never disagree with which rung PER_NIGHT_RAW_SQL took. */
const dateOverrideExistsSql = `EXISTS (SELECT 1 FROM listing_date_prices dp WHERE dp.listing_id = l.id AND dp.date = d::date)`

/** A calendar request may not ask for more than two years in one go. */
const MAX_CALENDAR_DAYS = 400

/**
 * A listing's calendar for [start, end] INCLUSIVE.
 *
 * `asHost` decides the money, exactly like the listing projections: a host sees
 * their raw prices (the numbers they type and PATCH back) plus a `guest_price`
 * companion, and anyone else sees only the commission-inclusive figure. A public
 * reader gets days and prices — never a booking id, never a host's block note.
 */
export async function getListingCalendar(
  listingId: string,
  start: string,
  end: string,
  opts: { asHost?: boolean } = {}
): Promise<ListingCalendar | null> {
  if (!isUuid(listingId) || !isIsoDate(start) || !isIsoDate(end)) return null
  if (end < start) return null
  if (daysBetween(start, end) + 1 > MAX_CALENDAR_DAYS) {
    throw new DatePriceError(`Ask for at most ${MAX_CALENDAR_DAYS} days at a time`)
  }
  const asHost = opts.asHost === true
  // `d` is the generate_series alias PER_NIGHT_RAW_SQL expects. The guest figure
  // is marked up PER NIGHT, not on the sum, so a guest multiplying a nightly rate
  // by the nights arrives at the subtotal we show them.
  const priceSql = asHost ? `(${PER_NIGHT_RAW_SQL})` : sqlWithCommission(PER_NIGHT_RAW_SQL)
  const { rows } = await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date,
            ${priceSql}::float8 AS price,
            ${sqlWithCommission(PER_NIGHT_RAW_SQL)}::float8 AS guest_price,
            CASE
              WHEN ${dateOverrideExistsSql} THEN 'custom'
              WHEN extract(dow from d)::int IN (5, 6) AND l.weekend_price IS NOT NULL THEN 'weekend'
              WHEN (l.monthly_prices ->> extract(month from d)::int::text) ~ '^[0-9.]+$' THEN 'monthly'
              ELSE 'base'
            END AS source,
            -- A booking outranks a block: if both cover the day, the host still
            -- may not touch it, and 'booked' is the honest reason why.
            CASE
              WHEN EXISTS (SELECT 1 FROM bookings b
                            WHERE b.listing_id = l.id AND b.status NOT IN ('cancelled', 'rejected')
                              AND b.check_in <= d AND b.check_out > d) THEN 'booked'
              WHEN EXISTS (SELECT 1 FROM listing_blocked_dates bd
                            WHERE bd.listing_id = l.id AND bd.start_date <= d AND bd.end_date > d) THEN 'blocked'
              ELSE 'available'
            END AS status,
            (SELECT bd.note FROM listing_blocked_dates bd
              WHERE bd.listing_id = l.id AND bd.start_date <= d AND bd.end_date > d
              ORDER BY bd.start_date DESC LIMIT 1) AS note,
            ${asHost ? 'l.price_per_night' : sqlWithCommission('l.price_per_night')}::float8 AS base_price,
            l.currency,
            ${COMMISSION_RATE_SQL}::float8 AS commission_rate
       FROM listings l,
            generate_series($2::date, $3::date, interval '1 day') AS d
      WHERE l.id = $1
      ORDER BY d ASC`,
    [listingId, start, end]
  )
  if (rows.length === 0) return null
  return {
    listing_id: listingId,
    currency: rows[0].currency ?? 'EGP',
    commission_rate: Number(rows[0].commission_rate),
    base_price: Number(rows[0].base_price),
    start,
    end,
    days: rows.map((r) => {
      const day: CalendarDay = {
        date: r.date,
        price: Math.round(Number(r.price)),
        source: r.source as PriceSource,
        status: r.status as DayStatus,
      }
      if (asHost) {
        day.guest_price = Math.round(Number(r.guest_price))
        day.note = r.note ?? null
      }
      return day
    }),
  }
}

/** What one calendar edit did. `skipped` is never silent — a day the host
 *  selected and we refused has to be reported back or they'd believe it saved. */
export interface CalendarUpdateResult {
  updated: number
  skipped: { date: string; reason: 'booked' }[]
  calendar: ListingCalendar
}

/**
 * Apply one calendar edit to a set of days the host selected.
 *
 * `price`:   a number pins that rate on every day; `null` RESETS them (deletes
 *            the rows, so they fall back to weekend/month/base); `undefined`
 *            leaves prices alone.
 * `blocked`: `true`/`false` closes or opens the days; `undefined` leaves
 *            availability alone.
 *
 * BOOKED DAYS ARE SKIPPED, not refused. A host dragging across a month will
 * routinely cross a reservation, and failing the whole edit would make the
 * feature unusable; the days that were skipped come back in the result so the
 * UI can say so. Note this is a guardrail, not data safety: bookings.total_price
 * is snapshotted at creation, so no price edit can ever restate a live stay.
 *
 * Everything runs in ONE transaction — a partial calendar (prices written,
 * blocks not) would be a state no host asked for.
 */
export async function updateListingCalendar(
  listingId: string,
  hostUserId: string,
  dates: string[],
  change: { price?: number | null; blocked?: boolean; note?: string | null },
  today: string
): Promise<CalendarUpdateResult | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  if (dates.length === 0) throw new DatePriceError('Select at least one date')
  assertWithinWindow(dates, today)

  const setsPrice = change.price !== undefined
  const setsBlocked = change.blocked !== undefined
  if (!setsPrice && !setsBlocked) throw new DatePriceError('Nothing to change')

  let price: number | null = null
  if (setsPrice) {
    const checked = checkDayPrice(change.price)
    if (!checked.ok) throw new DatePriceError(dayPriceMessage(checked.problem))
    price = checked.value
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const owns = await client.query(
      `SELECT 1 FROM listings WHERE id = $1 AND host_id = $2 FOR UPDATE`,
      [listingId, hostUserId]
    )
    if (!owns.rowCount) {
      await client.query('ROLLBACK')
      return null
    }

    // Which of the selected days a reservation already owns. Read INSIDE the
    // transaction and with the listing row locked, so a booking confirmed a
    // moment ago cannot slip between the check and the write.
    const booked = await client.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date
         FROM unnest($2::date[]) AS d
        WHERE EXISTS (SELECT 1 FROM bookings b
                       WHERE b.listing_id = $1 AND b.status NOT IN ('cancelled', 'rejected')
                         AND b.check_in <= d AND b.check_out > d)`,
      [listingId, dates]
    )
    const bookedDays = new Set<string>(booked.rows.map((r) => r.date as string))
    const editable = dates.filter((d) => !bookedDays.has(d))

    let updated = 0
    if (editable.length > 0 && setsPrice) {
      if (price === null) {
        // RESET is a delete. Writing the base price instead would pin a day that
        // then stopped tracking the base the moment the host edited it.
        const res = await client.query(
          `DELETE FROM listing_date_prices WHERE listing_id = $1 AND date = ANY($2::date[])`,
          [listingId, editable]
        )
        updated = res.rowCount ?? 0
      } else {
        const res = await client.query(
          `INSERT INTO listing_date_prices (listing_id, date, price)
           SELECT $1, d, $3::numeric FROM unnest($2::date[]) AS d
           ON CONFLICT (listing_id, date)
             DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
          [listingId, editable, price]
        )
        updated = res.rowCount ?? 0
      }
    }

    if (editable.length > 0 && setsBlocked) {
      await rewriteBlocks(client, listingId, editable, change.blocked === true, change.note ?? null)
      if (!setsPrice) updated = editable.length
    }

    await client.query('COMMIT')
    const calendar = await getListingCalendar(listingId, dates[0], dates[dates.length - 1], { asHost: true })
    return {
      updated,
      skipped: [...bookedDays].sort().map((date) => ({ date, reason: 'booked' as const })),
      // getListingCalendar can only be null for a listing that vanished between
      // the commit and the read; the edit still happened, so report an empty one.
      calendar: calendar ?? {
        listing_id: listingId, currency: 'EGP', commission_rate: 0, base_price: 0,
        start: dates[0], end: dates[dates.length - 1], days: [],
      },
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Block or unblock individual days inside a range-based table.
 *
 * listing_blocked_dates stores half-open [start_date, end_date) SPANS, so
 * "unblock the Wednesday in the middle of this week-long block" cannot be
 * expressed as a DELETE. We explode every span that overlaps what the host
 * touched into days, apply the change, re-merge, and rewrite that window —
 * which is exactly what applyBlockChange() does, and why it is a pure function
 * with its own tests.
 */
async function rewriteBlocks(
  client: PoolClient,
  listingId: string,
  dates: string[],
  blocked: boolean,
  note: string | null
): Promise<void> {
  // Any span that could be affected. Widened past the selection because a span
  // extends beyond the day the host clicked.
  const existing = await client.query(
    `SELECT id::text AS id,
            to_char(start_date, 'YYYY-MM-DD') AS start,
            to_char(end_date, 'YYYY-MM-DD') AS "end",
            note
       FROM listing_blocked_dates
      WHERE listing_id = $1
        AND start_date <= ($3::date + interval '1 day') AND end_date > $2::date
      FOR UPDATE`,
    [listingId, dates[0], dates[dates.length - 1]]
  )
  const spans = existing.rows as BlockSpan[]
  const window = blockRewriteWindow(spans, dates)
  if (!window) return

  const next = applyBlockChange(spans, dates, blocked, note)
  // Replace only the spans we just accounted for. Rewriting the whole listing
  // would drop blocks the host set far outside the window they were editing.
  if (spans.length > 0) {
    await client.query(
      `DELETE FROM listing_blocked_dates WHERE id = ANY($1::uuid[])`,
      [spans.map((s) => s.id)]
    )
  }
  const fresh = next.filter((s) => s.start <= window.to && s.end > window.from)
  for (const span of fresh) {
    await client.query(
      `INSERT INTO listing_blocked_dates (listing_id, start_date, end_date, note) VALUES ($1, $2, $3, $4)`,
      [listingId, span.start, span.end, span.note ?? null]
    )
  }
}

/** Whether `userId` owns `listingId`. Decides which money a calendar read
 *  returns — the host's raw prices or the guest-facing marked-up ones. */
export async function isListingHost(listingId: string, userId: string | null | undefined): Promise<boolean> {
  if (!isUuid(listingId) || !userId || !isUuid(userId)) return false
  const { rowCount } = await pool.query(
    `SELECT 1 FROM listings WHERE id = $1 AND host_id = $2`,
    [listingId, userId]
  )
  return (rowCount ?? 0) > 0
}

/** The host's pinned prices for a listing, as { 'YYYY-MM-DD': raw nightly }.
 *  Feeds the clients' local preview so it agrees with the server's charge. */
export async function getListingDatePrices(
  listingId: string,
  start: string,
  end: string
): Promise<Record<string, number>> {
  if (!isUuid(listingId) || !isIsoDate(start) || !isIsoDate(end)) return {}
  const { rows } = await pool.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, price::float8 AS price
       FROM listing_date_prices
      WHERE listing_id = $1 AND date >= $2::date AND date <= $3::date`,
    [listingId, start, end]
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.date as string] = Number(r.price)
  return out
}

/** How many days a host has pinned from today onwards — the "N custom prices"
 *  badge on the listing card, and the signal that the calendar is in use. */
export async function countUpcomingDatePrices(listingId: string): Promise<number> {
  if (!isUuid(listingId)) return 0
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM listing_date_prices WHERE listing_id = $1 AND date >= CURRENT_DATE`,
    [listingId]
  )
  return Number(rows[0]?.n ?? 0)
}

// ---- Bookings ---------------------------------------------------------------

/**
 * The commission rate to price a booking by: the rate SNAPSHOTTED when it was
 * taken, falling back to the live rate for rows written before the column
 * existed. Never the live rate for a booking that already has one — an admin
 * changing the rate must not restate a reservation a guest already agreed to.
 */
const BOOKING_RATE_SQL = `COALESCE(b.commission_rate, ${COMMISSION_RATE_SQL})`

// bookings.total_price stores the host's RAW stay total. This projection exposes
// only the COMMISSION-INCLUSIVE figure, because a booking response is read by the
// guest and the raw price would hand them the platform's margin. A host's payout
// is added explicitly by the host-only readers (see getHostBookings) and by
// money.ts, which query b.total_price directly.
const BOOKING_COLS = `
  b.id, b.listing_id, b.user_id, b.reservation_code,
  to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
  to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
  b.guests,
  ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)}::float8 AS total_price,
  b.status,
  COALESCE(b.payment_status, 'unpaid') AS payment_status,
  to_char(b.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS paid_at,
  b.payment_method,
  -- Latest transfer-screenshot submission for this booking (metadata only — the
  -- base64 image itself is fetched on demand via getBookingProof to keep lists light).
  (SELECT pp.status FROM payment_proofs pp WHERE pp.booking_id = b.id ORDER BY pp.submitted_at DESC LIMIT 1) AS payment_proof_status,
  (SELECT to_char(pp.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM payment_proofs pp WHERE pp.booking_id = b.id ORDER BY pp.submitted_at DESC LIMIT 1) AS payment_submitted_at,
  (SELECT pp.reject_reason FROM payment_proofs pp WHERE pp.booking_id = b.id ORDER BY pp.submitted_at DESC LIMIT 1) AS payment_reject_reason,
  b.host_notes,
  COALESCE(l.cancellation_policy, 'moderate') AS cancellation_policy,
  to_char(b.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cancelled_at,
  b.cancelled_by, b.cancelled_by_role, b.cancellation_policy AS booked_cancellation_policy,
  b.commission_rate,
  b.refund_percent,
  b.promo_code,
  b.promo_discount::float8 AS promo_discount,
  to_char(b.created_at, 'YYYY-MM-DD') AS created_at,
  l.title, l.location, l.region, l.host_id,
  (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS image
`

export interface CreateBookingInput {
  listingId: string
  userId: string
  checkIn: string
  checkOut: string
  guests: number
  /** Adults + children are the headcount checked against max_guests. Infants and
   *  pets are recorded but do not count toward it. */
  adults?: number
  children?: number
  infants?: number
  pets?: number
}

/**
 * Issue the reservation code at a CONFIRMATION transition, and only there.
 *
 * The rule (shared by the web, iOS and Android): a booking that is still waiting
 * for approval has NO code — `reservation_code` stays NULL, so there is no QR,
 * no wallet pass and no /stay/<code> link. The code is minted the moment the
 * booking becomes confirmed, and COALESCE makes that idempotent: once a guest is
 * holding a QR, re-confirming / a gateway retry / an admin edit never changes it.
 *
 * `when` is the SQL predicate that means "this row is becoming confirmed";
 * `param` is the placeholder carrying a freshly generated candidate code.
 */
function issueCodeSql(when: string, param: string): string {
  return `reservation_code = CASE WHEN ${when} THEN COALESCE(b.reservation_code, ${param}) ELSE b.reservation_code END`
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  const { listingId, userId, checkIn, checkOut, guests } = input
  if (!isUuid(listingId) || !isUuid(userId)) throw new Error('Invalid id')
  if (!isDate(checkIn) || !isDate(checkOut)) throw new Error('Invalid dates (use YYYY-MM-DD)')
  // No bookings that start in the past. ISO dates compare correctly as strings.
  const today = new Date().toISOString().slice(0, 10)
  if (checkIn < today) throw new Error('Check-in cannot be in the past')
  if (checkOut <= checkIn) throw new Error('Check-out must be after check-in')
  const nn = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0))
  // Adults + children = the headcount. Infants and pets don't count toward it.
  const adults = Math.max(1, nn(input.adults ?? guests))
  const children = nn(input.children)
  const infants = nn(input.infants)
  const pets = nn(input.pets)
  const g = Math.max(1, adults + children)

  // Load the listing (for max_guests / host) and enforce capacity. Search already
  // hides unpublished listings, but a booking can arrive with a listing id straight
  // from a deep link or a stale client, so the same rules are enforced here: an
  // unpublished listing and a blocked/removed host are both unbookable. Without
  // this, "hide their listings" would only hide them.
  const { rows: lrows } = await pool.query(
    `SELECT l.max_guests, COALESCE(l.is_published, false) AS is_published,
            COALESCE(hu.account_status, 'active') AS host_status
       FROM listings l LEFT JOIN users hu ON hu.id = l.host_id
      WHERE l.id = $1`,
    [listingId]
  )
  const listing = lrows[0] as
    | { max_guests: number | null; is_published: boolean; host_status: string }
    | undefined
  if (!listing) throw new Error('Could not create booking (listing not found)')
  if (!listing.is_published || listing.host_status !== 'active') {
    throw new Error('This listing is not available for booking')
  }
  if (listing.max_guests != null && g > listing.max_guests) {
    throw new Error('Exceeds the maximum guests for this listing')
  }

  // A rejected booking must not hold dates hostage — only cancelled and rejected are
  // excluded. listing_blocked_dates is part of the same question: a day the host
  // blocked on their calendar is unavailable even though no booking exists for it.
  const clash = await pool.query(
    `SELECT 1 FROM bookings
       WHERE listing_id = $1 AND status NOT IN ('cancelled', 'rejected')
         AND check_in < $2 AND check_out > $3
     UNION ALL
     SELECT 1 FROM listing_blocked_dates
       WHERE listing_id = $1
         AND start_date < $2 AND end_date > $3
     LIMIT 1`,
    [listingId, checkOut, checkIn]
  )
  if (clash.rowCount && clash.rowCount > 0) throw new Error('Those dates are not available')

  // NO reservation_code here on purpose — a booking starts 'pending' (awaiting the
  // host's approval) and a pending booking must have no code / no QR. It is issued
  // at the confirmation transition (see issueCodeSql).
  const { rows } = await pool.query(
    `WITH ins AS (
       -- cancellation_policy and commission_rate are SNAPSHOTTED here on purpose:
       -- both are editable after the fact (the listing's policy by its host, the
       -- rate by an admin), and a report must reflect what was in force when the
       -- booking was taken. See migrate-analytics.mjs.
       INSERT INTO bookings (listing_id, user_id, check_in, check_out, guests,
                             adults, children, infants, pets, total_price, status,
                             cancellation_policy, commission_rate)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9,
         -- total_price is the host's RAW stay total — what the host is owed and
         -- what payout/earnings read directly. The guest's figure is derived as
         -- total_price × (1 + commission_rate) using the rate snapshotted below,
         -- so an admin changing the rate can never restate a live reservation.
         round(
           (SELECT COALESCE(sum(${PER_NIGHT_RAW_SQL}), 0)
            FROM generate_series($3::date, $4::date - interval '1 day', interval '1 day') AS d)
           -- Length-of-stay discount on the whole stay. Shared with the web via
           -- date-pricing-core so both projects price a long stay the same.
           * ${stayDiscountFactorSql('$3', '$4')}
         ),
         'pending',
         COALESCE(l.cancellation_policy, 'moderate'),
         ${COMMISSION_RATE_SQL}
       FROM listings l WHERE l.id = $1
       RETURNING *
     )
     SELECT ${BOOKING_COLS} FROM ins b JOIN listings l ON l.id = b.listing_id`,
    [listingId, userId, checkIn, checkOut, g, adults, children, infants, pets]
  )
  if (!rows[0]) throw new Error('Could not create booking (listing not found)')
  const booking = rows[0] as Booking
  // Notify the host that a guest requested their listing — in-app + push + email.
  await createNotification(booking.host_id, {
    type: 'booking_request',
    title: 'New booking request',
    body: `${booking.guests} guest(s) requested ${booking.title}`,
    link: '/host',
  })
  if (booking.host_id) {
    await sendPush(booking.host_id, {
      title: 'New booking request',
      body: `${booking.guests} guest(s) requested ${booking.title}`,
      link: '/host',
    })
    const hostEmail = await userEmail(booking.host_id)
    if (hostEmail) {
      await sendNotificationEmail(
        hostEmail,
        'New booking request — QuickIn',
        'You have a new booking request',
        [
          `${booking.guests} guest(s) requested <strong>${booking.title}</strong>.`,
          `Dates: ${booking.check_in} → ${booking.check_out}.`,
          'Open your host dashboard to confirm or decline.',
        ],
        { label: 'Open host dashboard', url: `${WEB_URL}/host` }
      )
    }
  }
  return booking
}

export async function getUserBookings(userId: string): Promise<Booking[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN listings l ON l.id = b.listing_id
     WHERE b.user_id = $1 ORDER BY b.check_in DESC`,
    [userId]
  )
  return rows as Booking[]
}

/** Records the promo code + discount applied to a booking (set at pay time). */
export async function setBookingPromo(
  bookingId: string,
  userId: string,
  code: string,
  discount: number
): Promise<void> {
  if (!isUuid(bookingId) || !isUuid(userId)) return
  await pool.query(
    `UPDATE bookings SET promo_code = $3, promo_discount = $4 WHERE id = $1 AND user_id = $2`,
    [bookingId, userId, code.toUpperCase().slice(0, 40), Math.max(0, Math.round(discount))]
  )
}

/** Host attaches free-text notes to a stay (directions, gate code, city tips…)
 *  shown on the QR-linked pass page. Only the listing's host may set them. */
export async function setBookingNotes(bookingId: string, hostUserId: string, notes: string): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(hostUserId)) return null
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET host_notes = $3
       FROM listings l
       WHERE b.id = $1 AND b.listing_id = l.id AND l.host_id = $2
       RETURNING b.*
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, hostUserId, (notes ?? '').slice(0, 2000)]
  )
  return (rows[0] as Booking) ?? null
}

// ---- Cancellation policy ----------------------------------------------------

// The policy type, its values and the coercion live in cancellation-core.ts, beside
// the refund ladder that reads them. Re-exported here because callers have always
// imported them from db.ts.
export type { CancellationPolicy } from './cancellation-core'
export { CANCELLATION_POLICIES, normalizePolicy }

export interface CancellationQuote {
  policy: CancellationPolicy
  daysUntilCheckIn: number
  refundPercent: number
  refundAmount: number
  total: number
  currency: string
}

/** Refund % a guest gets for cancelling `daysUntilCheckIn` before check-in,
 *  given the listing's policy. Mock semantics (no real gateway yet):
 *   flexible — 100% if ≥1 day out, else 0%.
 *   moderate — 100% if ≥5 days out, else 50%.
 *   strict   — 50% if ≥7 days out, else 0%. */

function daysUntil(dateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr + 'T00:00:00')
  return Math.floor((target.getTime() - today.getTime()) / 86_400_000)
}

/** What the guest would get back if they cancelled now (no mutation). */
/** The one row both the quote and the cancel need: what the guest PAID, how far out
 *  the stay is, and whether it can still be cancelled. Keyed on (booking, guest) so a
 *  stranger's booking id resolves to nothing rather than to someone else's refund. */
async function loadCancelable(userId: string, bookingId: string) {
  const { rows } = await pool.query(
    // Commission-inclusive on purpose: a refund is a percentage of what the GUEST
    // paid, not of the host's raw price. See cancellation-core -> refundAmountFor.
    `SELECT b.status, ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)}::float8 AS total,
            COALESCE(l.currency, 'EGP') AS currency,
            (b.check_in - CURRENT_DATE)::int AS days_until,
            -- The SNAPSHOT the booking was taken under, falling back to the listing's
            -- current policy only for rows written before the column existed. A host
            -- tightening their terms today must not reprice a stay already agreed.
            COALESCE(b.cancellation_policy, l.cancellation_policy, 'moderate') AS policy
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.id = $1 AND b.user_id = $2`,
    [bookingId, userId]
  )
  return rows[0] as
    | { status: string; total: number; currency: string; days_until: number; policy: string }
    | undefined
}

/** Argument order is (userId, bookingId) in BOTH projects. They used to disagree, and
 *  since both are strings a swapped call compiles cleanly and silently returns null. */
export async function getCancellationQuote(
  userId: string,
  bookingId: string
): Promise<CancellationQuote | null> {
  if (!isUuid(bookingId) || !isUuid(userId)) return null
  const b = await loadCancelable(userId, bookingId)
  if (!b) return null
  // An already-cancelled booking owes nothing further — the guard against a retried
  // request refunding twice.
  const policy = normalizePolicy(b.policy)
  const refundPercent = isCancellable(b.status) ? refundPercentFor(policy, b.days_until) : 0
  return {
    policy,
    daysUntilCheckIn: b.days_until,
    refundPercent,
    refundAmount: refundAmountFor(b.total, refundPercent),
    total: b.total,
    currency: b.currency,
  }
}

/** A guest cancels their own (pending/confirmed) booking. Records the mock
 *  refund per the listing's policy, sets status='cancelled', notifies the host.
 *  Returns the updated booking + the quote, or null if it isn't the guest's /
 *  can't be cancelled. */
export async function cancelBooking(
  userId: string,
  bookingId: string
): Promise<{ booking: Booking; quote: CancellationQuote } | null> {
  const quote = await getCancellationQuote(userId, bookingId)
  if (!quote) return null
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET
         status = 'cancelled',
         cancelled_at = now(),
         refund_percent = $3,
         refund_amount = $4,
         -- B3: record the actor in the SAME statement as the status change, so it
         -- can never be skipped. $2 is the guest's own id (also the WHERE guard).
         cancelled_by = $2::text,
         cancelled_by_role = 'guest'
       WHERE b.id = $1 AND b.user_id = $2 AND b.status IN ('pending', 'confirmed')
       RETURNING *
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, userId, quote.refundPercent, quote.refundAmount]
  )
  const booking = rows[0] as Booking | undefined
  if (!booking) return null
  if (booking.host_id) {
    await createNotification(booking.host_id, {
      type: 'booking_cancelled',
      title: 'Reservation cancelled',
      body: `${booking.title} — ${booking.check_in} → ${booking.check_out} was cancelled by the guest.`,
      link: '/host',
    })
    await sendPush(booking.host_id, {
      title: 'Reservation cancelled',
      body: `${booking.title} (${booking.reservation_code ?? ''})`,
      link: '/host',
    })
  }
  return { booking, quote }
}

// The three single-purpose host edits below predate the full edit form. They now
// delegate to updateListingDetails so there is exactly ONE code path that writes a
// listing — and therefore no way to change a listing without the re-review rule in
// REVIEW_TRIGGERING_FIELDS applying. Signatures and return values are unchanged.

/** Host updates the cancellation policy on their own listing. Returns the
 *  refreshed listing, or null if the caller isn't the host. */
export async function updateListingPolicy(
  listingId: string,
  hostUserId: string,
  policy: string
): Promise<Listing | null> {
  return updateListingDetails(listingId, hostUserId, { cancellation_policy: policy })
}

/** Host updates the length-of-stay discounts (% off) on their own listing. */
export async function updateListingDiscounts(
  listingId: string,
  hostUserId: string,
  weekly: number,
  monthly: number
): Promise<Listing | null> {
  return updateListingDetails(listingId, hostUserId, {
    weekly_discount: weekly,
    monthly_discount: monthly,
  })
}

/** Host sets seasonal pricing: weekend nightly price + per-month overrides. */
export async function updateListingPricing(
  listingId: string,
  hostUserId: string,
  weekendPrice: unknown,
  monthlyPrices: unknown
): Promise<Listing | null> {
  return updateListingDetails(listingId, hostUserId, {
    weekend_price: weekendPrice ?? null,
    monthly_prices: monthlyPrices ?? {},
  })
}

export interface StayQuote {
  nights: number
  /** Commission-inclusive. Ties out exactly as nights × nightlyAvg when the
   *  listing has no seasonal pricing. */
  subtotal: number
  discountPercent: number
  /** Commission-inclusive, after the length-of-stay discount. What the guest owes. */
  total: number
  nightlyAvg: number
  currency: string
  hasSeasonalPricing: boolean
  /** Every night of the stay, priced and labelled — what the booking summary
   *  itemises. Commission-inclusive, like every other figure here. The nights
   *  are [checkIn, checkOut), so the checkout day is absent: a guest is never
   *  charged for the morning they leave. */
  nights_breakdown: { date: string; price: number; source: PriceSource }[]
  /** True when at least one night was pinned on the host's calendar. Clients use
   *  it to decide whether the per-night list is worth showing at all. */
  hasCustomNights: boolean
}

/** Authoritative price for a date range — honors the host's calendar, weekend +
 *  monthly pricing and the length-of-stay discount (same maths the booking
 *  uses). Lets clients show the exact total for the chosen dates without
 *  duplicating the logic.
 *
 *  GUEST-FACING and PUBLIC: every figure includes the platform commission and
 *  the host's raw price is never returned. Each night is marked up and rounded
 *  individually before summing, so a guest can multiply the nightly rate by the
 *  number of nights and arrive at the subtotal we show them. */
export async function getStayQuote(listingId: string, checkIn: string, checkOut: string): Promise<StayQuote | null> {
  if (!isUuid(listingId) || !isDate(checkIn) || !isDate(checkOut) || checkOut <= checkIn) return null
  // One row per NIGHT rather than one aggregate row: the summary has to itemise
  // "Aug 16 · 3,850 EGP" per night, and re-deriving that client-side is exactly
  // the duplication this endpoint exists to prevent. The subtotal is then summed
  // from the same rows the guest is shown, so the list always adds up to it.
  const { rows } = await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date,
            ${sqlWithCommission(PER_NIGHT_RAW_SQL)}::float8 AS price,
            CASE
              WHEN ${dateOverrideExistsSql} THEN 'custom'
              WHEN extract(dow from d)::int IN (5, 6) AND l.weekend_price IS NOT NULL THEN 'weekend'
              WHEN (l.monthly_prices ->> extract(month from d)::int::text) ~ '^[0-9.]+$' THEN 'monthly'
              ELSE 'base'
            END AS source,
            (CASE WHEN ($3::date - $2::date) >= 28 THEN COALESCE(l.monthly_discount, 0)
                  WHEN ($3::date - $2::date) >= 7  THEN COALESCE(l.weekly_discount, 0)
                  ELSE 0 END)::int AS discount_percent,
            (l.weekend_price IS NOT NULL OR l.monthly_prices <> '{}'::jsonb) AS has_seasonal,
            l.currency
       FROM listings l,
            generate_series($2::date, $3::date - interval '1 day', interval '1 day') AS d
      WHERE l.id = $1
      ORDER BY d ASC`,
    [listingId, checkIn, checkOut]
  )
  const r = rows[0]
  if (!r) return null
  const breakdown = rows.map((row) => ({
    date: row.date as string,
    price: Math.round(Number(row.price)),
    source: row.source as PriceSource,
  }))
  const nights = breakdown.length
  // Each night is already a multiple of 10 (marked up and rounded individually),
  // so this sum needs no further rounding — and it ties out against the list the
  // guest can see, which a separately-computed aggregate would not guarantee.
  const subtotal = breakdown.reduce((sum, n) => sum + n.price, 0)
  const discountPercent = Number(r.discount_percent)
  // The discount reintroduces a fraction, so land the total back on a multiple
  // of 10. Rounding UP here matches every other guest-facing figure.
  const total = roundUpToStep(subtotal * (1 - discountPercent / 100))
  return {
    nights,
    subtotal,
    discountPercent,
    total,
    nightlyAvg: nights > 0 ? Math.round(subtotal / nights) : subtotal,
    currency: r.currency ?? 'EGP',
    // The host's calendar counts as seasonal pricing: a stay whose nights differ
    // from each other must not be summarised as "price × nights".
    hasSeasonalPricing: Boolean(r.has_seasonal) || breakdown.some((n) => n.source === 'custom'),
    nights_breakdown: breakdown,
    hasCustomNights: breakdown.some((n) => n.source === 'custom'),
  }
}

// ---- Listing approval queue (S7) -------------------------------------------

/** Listings awaiting moderation, with the host's name/email + the ownership doc
 *  (admin only — the doc is never exposed publicly). */
export async function listPendingListings(): Promise<
  (Listing & { host_email: string | null; has_ownership_doc: boolean })[]
> {
  // The ownership document itself is NOT returned. It used to ride inline, as base64,
  // on every pending listing, for anyone holding the `listings` module and with no
  // record of who saw it. The web project now serves one document at a time from
  // /api/local/admin/documents/ownership/:id, behind the `documents` module, and
  // audits every open. No mobile client ever read this field.
  const { rows } = await pool.query(
    `SELECT ${LISTING_COLS_HOST},
            (SELECT u.email FROM users u WHERE u.id = l.host_id) AS host_email,
            (l.ownership_doc IS NOT NULL AND l.ownership_doc <> '') AS has_ownership_doc
       FROM listings l
      WHERE COALESCE(l.approval_status, 'approved') = 'pending'
      ORDER BY l.created_at DESC`
  )
  return rows as (Listing & { host_email: string | null; has_ownership_doc: boolean })[]
}

/** Admin approves (publish + 'approved') or rejects (unpublish + 'rejected') a
 *  listing; notifies the host. Returns the refreshed listing.
 *
 *  Approving is refused while the listing's host is not identity-verified. The
 *  create route already blocks unverified hosts, but this is the actual publish
 *  step — a listing can outlive the verification that allowed it (an admin can
 *  revoke, or a listing may predate the gate), and going live is the moment that
 *  matters. Throws so the caller surfaces the reason rather than silently
 *  reporting success on a listing that stayed hidden. */
export async function setListingApproval(
  listingId: string,
  approve: boolean,
  /** Optional reason shown to the host on a rejection. Ignored when approving. */
  note?: string | null
): Promise<Listing | null> {
  if (!isUuid(listingId)) return null
  if (approve) {
    const { rows: hostRows } = await pool.query(
      `SELECT COALESCE(u.verification_status, 'unverified') AS status, u.email
         FROM listings l JOIN users u ON u.id = l.host_id
        WHERE l.id = $1`,
      [listingId]
    )
    const host = hostRows[0]
    if (host && host.status !== 'verified') {
      throw new ListingInputError(
        `This host is not identity-verified (${host.status}). Approve their ID in Verifications first — a listing must not go live before its host is verified.`
      )
    }
  }
  const status = approve ? 'approved' : 'rejected'
  // The note is stored, not just announced — it used to live only inside the
  // notification body, so a host who missed that notification saw a "Rejected" badge
  // with no reason. Approving clears it: the note describes a rejection, and a stale
  // one under a live listing reads as a fresh complaint.
  const reviewNote = approve ? null : normalizeListingReviewNote(note)
  const { rows } = await pool.query(
    `UPDATE listings SET approval_status = $2, is_published = $3, review_note = $4 WHERE id = $1
     RETURNING id, host_id, title`,
    [listingId, status, approve, reviewNote]
  )
  const r = rows[0]
  if (!r) return null
  if (r.host_id) {
    await createNotification(r.host_id, {
      type: approve ? 'listing_approved' : 'listing_rejected',
      title: approve ? 'Your listing is live 🎉' : 'Listing needs changes',
      // Composed from the SAME normalized note that was just stored, so the
      // notification and the reason on the host's dashboard can never disagree.
      body: approve
        ? `“${r.title}” has been approved and is now visible to guests.`
        : listingRejectionMessage(r.title, reviewNote),
      link: '/host',
    })
    await sendPush(r.host_id, {
      title: approve ? 'Listing approved 🎉' : 'Listing not approved',
      body: r.title,
      link: '/host',
    })
  }
  return getListingById(listingId, { asHost: true })
}

/** Host uploads/replaces their ownership doc → re-queues the listing to
 *  'pending' (and unpublishes) for re-review. Host-only. */
export async function setListingOwnershipDoc(
  listingId: string,
  hostUserId: string,
  doc: string
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  const d = assertOwnershipDoc(doc)
  const { rowCount } = await pool.query(
    `UPDATE listings SET ownership_doc = $3, ${REQUEUE_SET}
      WHERE id = $1 AND host_id = $2`,
    [listingId, hostUserId, d]
  )
  if (!rowCount) return null
  const updated = await getListingById(listingId, { asHost: true })
  if (updated) await notifyListingRequeued(updated)
  return updated
}

// ---- Full listing edit → automatic re-review (W3) ---------------------------
// A host can edit EVERY aspect of their own listing — details, pricing, photos —
// from web/iOS/Android. Two invariants hold for every helper below:
//   1. Ownership is enforced inside the SQL (`WHERE id = $1 AND host_id = $2`, or
//      a join back to listings.host_id for listing_images). A host id is never
//      taken from the request body. No row matched → null → the route answers 403.
//   2. The re-review flip lives in the SAME statement as the edit, so it can't be
//      skipped — exactly like setListingOwnershipDoc above.

/** Property types the create-listing forms offer (web icon grid, iOS
 *  AddListingView, Android HostScreen). The stored value stays English —
 *  clients translate the label only — so matching is case-insensitive. */
export const PROPERTY_TYPES = [
  'Apartment', 'House', 'Villa', 'Cabin', 'Studio', 'Loft', 'Chalet', 'Cottage',
  'Guest suite', 'Guest House',
] as const

/** Max photos on a listing — the cap createListing already enforces. */
export const MAX_LISTING_PHOTOS = 10

/** Max chars for an inline image (data: URL) — same budget as the ownership doc. */
const MAX_IMAGE_CHARS = 3_500_000

/** Every field a host may edit through PATCH /api/local/listings/:id.
 *  `images` is the photo set (listing_images rows), not a listings column. */
export const EDITABLE_LISTING_FIELDS = [
  // Moderation-relevant — what an admin actually looks at.
  'title', 'description', 'location', 'country', 'region', 'resort', 'lat', 'lng',
  'property_type', 'max_guests', 'bedrooms', 'beds', 'bathrooms', 'amenities',
  'ownership_doc', 'images',
  // Commercial — what the host tunes day to day.
  'price_per_night', 'weekend_price', 'monthly_prices',
  'weekly_discount', 'monthly_discount', 'cancellation_policy',
] as const
export type ListingEditField = (typeof EDITABLE_LISTING_FIELDS)[number]

/**
 * THE re-review switch — the ONE place that decides which host edits send a
 * listing back to the admin queue (approval_status='pending' + is_published=false).
 *
 * Product decision, as specified: EVERY edit re-reviews, including price,
 * discounts, seasonal pricing and cancellation policy — so a host nudging their
 * nightly rate takes their own listing offline until an admin approves it.
 * To move to the usual split (moderation fields re-review, commercial fields save
 * live) replace the value below with the moderation subset, e.g.
 *   export const REVIEW_TRIGGERING_FIELDS: readonly ListingEditField[] =
 *     ['title','description','location','country','region','lat','lng',
 *      'property_type','max_guests','bedrooms','beds','bathrooms','amenities',
 *      'ownership_doc','images']
 * Nothing else in the codebase needs to change.
 */
export const REVIEW_TRIGGERING_FIELDS: readonly ListingEditField[] = EDITABLE_LISTING_FIELDS

/** Does this set of edited fields put the listing back in front of an admin? */
export function requeuesForReview(fields: readonly string[]): boolean {
  return fields.some((f) => (REVIEW_TRIGGERING_FIELDS as readonly string[]).includes(f))
}

/** Photos are one field of the edit form — same switch, asked once. */
const photosRequeue = () => requeuesForReview(['images'])

/** The SET fragment every re-queueing edit appends — identical to the ownership-doc flow. */
const REQUEUE_SET = `approval_status = 'pending', is_published = false, review_note = NULL`

/** Something the host can fix in the form (→ HTTP 400), as opposed to a real
 *  failure (→ 500). A named class rather than message-sniffing, so adding a
 *  validation rule can't silently start answering 500. Mirrors the web's
 *  HostApplicationError. */
export class ListingInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ListingInputError'
  }
}

/** Was this thrown by one of the listing validators above? (`name` is checked too
 *  so it still works if the module is instantiated twice in a bundle.) A blocked
 *  contact detail counts: it is the host's input to fix, not a server fault. */
export function isListingInputError(err: unknown): err is Error {
  // A blocked contact detail counts: it is the host's input to fix, not a
  // server fault, so the route answers 400 with the guard's wording.
  if (isContactBlockedError(err)) return true
  return err instanceof ListingInputError || (err instanceof Error && err.name === 'ListingInputError')
}

/** A photo / document source: an inline data:image or an http(s) URL, bounded in
 *  size. Mirrors setListingOwnershipDoc + assertProofImage. */
function assertImageSrc(src: unknown, message = 'Please attach a valid photo'): string {
  const v = String(src ?? '').trim()
  if (!/^(data:image\/|https?:\/\/)/i.test(v)) throw new ListingInputError(message)
  if (v.length > MAX_IMAGE_CHARS) throw new ListingInputError('That image is too large')
  return v
}

/** The proof-of-ownership document, which unlike a listing photo may also be a
 *  PDF — a title deed is issued as a document, not photographed as one. The rule
 *  lives in ownership-doc-core.ts, a verbatim copy of quickin-frontend's, so a
 *  document accepted on the website is accepted here too. */
function assertOwnershipDoc(src: unknown): string {
  const v = String(src ?? '').trim()
  const problem = checkOwnershipDoc(v)
  if (problem) throw new ListingInputError(ownershipDocProblemMessage(problem))
  return v
}

/** Non-blank text, else a per-field error (the clients highlight the input). */
function assertText(v: unknown, label: string): string {
  const s = String(v ?? '').trim()
  if (!s) throw new ListingInputError(`${label} is required`)
  return s
}

/** A title that reads as a title, else a per-field error. Shared by `createListing`
 *  and the title branch of the edit patch, so the create and edit doors can never
 *  disagree — and shared with the web repo through listing-title-policy.ts, so the
 *  mobile apps and the website cannot either. `12345` is refused here; `Sa7el
 *  chalet` is not. */
function assertListingTitle(v: unknown): string {
  const s = normalizeListingTitle(v)
  const problem = validateListingTitle(s)
  if (problem) throw new ListingInputError(problem)
  return s
}

/**
 * A typed "Other — not listed" compound name that reads as a name, else the same
 * sentence the web host forms show. Shares its rule with them through
 * resort-core.ts — `@@@@@` was accepted here too, and a name with no letters has
 * no slug, so the write path stored it as no resort at all.
 *
 * Two cases pass straight through, and both are real answers rather than
 * oversights: a resort PICKED from the catalog (the typed text is ignored when an
 * id is present), and nothing typed at all (a chalet outside any compound, or an
 * edit clearing the resort).
 */
function assertResortName(resortId: unknown, resortName: unknown): void {
  if (typeof resortId === 'string' && resortId.trim()) return
  if (normalizeResortName(resortName) === null) return
  const problem = validateResortName(resortName)
  if (problem) throw new ListingInputError(problem)
}

/** A whole number >= min, else a per-field error. */
function assertInt(v: unknown, label: string, min: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new ListingInputError(`${label} must be a whole number of at least ${min}`)
  }
  return n
}

/** A coordinate inside its valid range, or null to clear the pin. */
function assertCoord(v: unknown, label: string, limit: number): number | null {
  if (v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new ListingInputError(`${label} must be between -${limit} and ${limit}`)
  return n
}

/** Canonical (English) property type for any casing the clients send. */
function assertPropertyType(v: unknown): string {
  const s = String(v ?? '').trim()
  const match = PROPERTY_TYPES.find((p) => p.toLowerCase() === s.toLowerCase())
  if (!match) throw new ListingInputError(`Choose a property type: ${PROPERTY_TYPES.join(', ')}`)
  return match
}

/** Canonical region — one of REGIONS, the same chips search filters on. */
function assertRegion(v: unknown): string {
  const s = String(v ?? '').trim()
  const match = REGIONS.find((r) => r.toLowerCase() === s.toLowerCase())
  if (!match) throw new ListingInputError(`Choose an area: ${REGIONS.join(', ')}`)
  return match
}

/** An array of non-empty amenity names (trimmed, deduped). */
function assertAmenities(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ListingInputError('Amenities must be a list')
  const out: string[] = []
  for (const a of v) {
    if (typeof a !== 'string') throw new ListingInputError('Amenities must be a list of names')
    const s = a.trim().slice(0, 64)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** The full replacement photo set for a listing (array order = display order, so
 *  the first entry is the cover). Validated like every other image we accept. */
function assertPhotoSet(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ListingInputError('Photos must be a list')
  if (v.length > MAX_LISTING_PHOTOS) throw new ListingInputError(`A listing can have at most ${MAX_LISTING_PHOTOS} photos`)
  return v.map((u) => assertImageSrc(u, 'Each photo must be an image'))
}

/** Partial edit — ONLY the keys actually present are written; omitted keys keep
 *  their current value (never nulled out). Values are `unknown` by design: the
 *  route hands the raw JSON straight through and validation happens here, once. */
export interface ListingPatch {
  title?: unknown
  description?: unknown
  location?: unknown
  country?: unknown
  region?: unknown
  resort_id?: unknown
  resort_name?: unknown
  lat?: unknown
  lng?: unknown
  property_type?: unknown
  max_guests?: unknown
  bedrooms?: unknown
  beds?: unknown
  bathrooms?: unknown
  amenities?: unknown
  ownership_doc?: unknown
  /** Full replacement photo set (first = cover). Omit to leave photos untouched. */
  images?: unknown
  price_per_night?: unknown
  weekend_price?: unknown
  monthly_prices?: unknown
  weekly_discount?: unknown
  monthly_discount?: unknown
  cancellation_policy?: unknown
}

/**
 * Host edits their own listing. Ownership is enforced in the SQL, so a listing
 * that isn't theirs matches no row and returns null (the route maps that to 403).
 * Every re-review-triggering field (today: all of them — see
 * REVIEW_TRIGGERING_FIELDS) puts the listing back to 'pending' + unpublished in
 * the SAME statement as the edit. Returns the refreshed listing.
 */
export async function updateListingDetails(
  listingId: string,
  hostUserId: string,
  patch: ListingPatch
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null

  // The same bar the create door holds, applied to the fields THIS patch touches
  // — see listing-completeness-policy.ts. A listing that cleared the bar when it
  // was created must not be editable back below it, and clearing a field is
  // touching it. Fields the patch leaves alone are not judged: a patch is
  // partial by design here more than anywhere — the iOS app re-submits a proof
  // document with `PATCH { ownership_doc }` and nothing else, and its edit screen
  // never sends `images` at all, because photos travel through the /images
  // routes (which carry their own floor — see deleteListingImage).
  //
  // Two of the rules span more than one column — the pin is a lat/lng pair, the
  // area can be answered by a region OR by a resort — so when the patch touches
  // either, the half already stored is read and merged before judging. That read
  // doubles as the ownership check, which is why a miss returns the same `null`
  // (404) the UPDATE would have.
  const touchesMergedField =
    patch.region !== undefined ||
    patch.resort_id !== undefined ||
    patch.resort_name !== undefined ||
    patch.lat !== undefined ||
    patch.lng !== undefined
  let current: ListingCurrentState = {}
  if (touchesMergedField) {
    const { rows: cur } = await pool.query(
      `SELECT region, resort_id, resort_name, lat::float8 AS lat, lng::float8 AS lng
         FROM listings WHERE id = $1 AND host_id = $2`,
      [listingId, hostUserId]
    )
    if (!cur.length) return null
    current = cur[0] as ListingCurrentState
  }
  const editProblem = checkListingEdit(patch, current)
  if (editProblem) throw new ListingInputError(listingCompletenessProblemMessage(editProblem))

  const sets: string[] = []
  const vals: unknown[] = [listingId, hostUserId]
  const touched: ListingEditField[] = []
  // Column name === patch key for every scalar field, so one helper covers them all.
  const put = (field: Exclude<ListingEditField, 'images'>, val: unknown, cast = '') => {
    vals.push(val)
    sets.push(`${field} = $${vals.length}${cast}`)
    touched.push(field)
  }

  // --- Moderation-relevant fields ---
  // Guarded on edit as well as on create — otherwise a clean listing could be
  // published and then quietly edited to carry a number.
  if (patch.title !== undefined) {
    // `.slice(0, 200)` used to stand here and silently truncated; the policy
    // refuses an over-long title instead of storing half of one.
    const title = assertListingTitle(patch.title)
    await guardContent(hostUserId, title, 'listing', { type: 'listing', id: listingId })
    put('title', title)
  }
  if (patch.description !== undefined) {
    const description = assertText(patch.description, 'Description').slice(0, 5000)
    await guardContent(hostUserId, description, 'listing', { type: 'listing', id: listingId })
    put('description', description)
  }
  if (patch.location !== undefined) put('location', assertText(patch.location, 'Location').slice(0, 200))
  if (patch.country !== undefined) put('country', String(patch.country ?? '').trim().slice(0, 100) || null)
  // Resort is THREE columns (resort_id, resort_name, region) driven by one logical
  // edit, so it cannot go through put(), which maps one field to one column. When a
  // resort is chosen its region wins, so the standalone region edit is skipped.
  const resortEdited = patch.resort_id !== undefined || patch.resort_name !== undefined
  if (patch.region !== undefined && !resortEdited) put('region', assertRegion(patch.region))
  if (resortEdited) {
    // A listing that was created with a real compound name must not be editable
    // down to `!!!!!` afterwards — same rule the create door runs.
    assertResortName(patch.resort_id, patch.resort_name)
    const sel = await resolveResortSelection({
      resortId: patch.resort_id === undefined ? null : String(patch.resort_id ?? '') || null,
      resortName: patch.resort_name === undefined ? null : (patch.resort_name as string | null),
      region: patch.region === undefined ? null : assertRegion(patch.region),
      userId: hostUserId,
    })
    vals.push(sel.resort_id); sets.push(`resort_id = $${vals.length}::uuid`)
    vals.push(sel.resort_name); sets.push(`resort_name = $${vals.length}`)
    vals.push(sel.region); sets.push(`region = $${vals.length}`)
    touched.push('resort')
  }
  if (patch.lat !== undefined) put('lat', assertCoord(patch.lat, 'Latitude', 90))
  if (patch.lng !== undefined) put('lng', assertCoord(patch.lng, 'Longitude', 180))
  if (patch.property_type !== undefined) put('property_type', assertPropertyType(patch.property_type))
  // max_guests keeps createListing's floor of 1 — a 0-guest listing can't be booked.
  if (patch.max_guests !== undefined) put('max_guests', assertInt(patch.max_guests, 'Guests', 1))
  if (patch.bedrooms !== undefined) put('bedrooms', assertInt(patch.bedrooms, 'Bedrooms', 0))
  if (patch.beds !== undefined) put('beds', assertInt(patch.beds, 'Beds', 0))
  if (patch.bathrooms !== undefined) put('bathrooms', assertInt(patch.bathrooms, 'Bathrooms', 0))
  if (patch.amenities !== undefined) put('amenities', assertAmenities(patch.amenities))
  if (patch.ownership_doc !== undefined) {
    put('ownership_doc', assertOwnershipDoc(patch.ownership_doc))
  }

  // --- Commercial fields (same re-review rule today) ---
  if (patch.price_per_night !== undefined) {
    const price = Number(patch.price_per_night)
    if (!Number.isFinite(price) || price <= 0) throw new ListingInputError('Price must be greater than 0')
    put('price_per_night', Math.round(price))
  }
  if (patch.weekend_price !== undefined) put('weekend_price', cleanPrice(patch.weekend_price))
  if (patch.monthly_prices !== undefined) put('monthly_prices', cleanMonthlyPrices(patch.monthly_prices), '::jsonb')
  if (patch.weekly_discount !== undefined) put('weekly_discount', clampDiscount(patch.weekly_discount))
  if (patch.monthly_discount !== undefined) put('monthly_discount', clampDiscount(patch.monthly_discount))
  if (patch.cancellation_policy !== undefined) put('cancellation_policy', normalizePolicy(String(patch.cancellation_policy)))

  // --- Photos (listing_images rows, replaced wholesale when supplied) ---
  // null = not sent (leave photos alone); [] = sent empty (clear them).
  const nextPhotos = patch.images === undefined ? null : assertPhotoSet(patch.images)
  if (nextPhotos !== null) touched.push('images')

  if (!touched.length) throw new ListingInputError('No listing fields to update')
  const requeue = requeuesForReview(touched)

  // As in addListingImages: upload before the transaction, insert the URLs.
  // Photos already stored as URLs pass through untouched, so re-saving a
  // listing whose photos have not changed uploads nothing.
  const storedPhotos = nextPhotos === null ? null : await storeListingPhotos(listingId, nextPhotos)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (sets.length || requeue) {
      // Ownership + the re-review flip in ONE statement — nothing can bypass it.
      const { rowCount } = await client.query(
        `UPDATE listings SET ${[...sets, ...(requeue ? [REQUEUE_SET] : [])].join(', ')}
          WHERE id = $1 AND host_id = $2`,
        vals
      )
      if (!rowCount) {
        await client.query('ROLLBACK')
        return null
      }
    } else if (!(await ownsListing(client, listingId, hostUserId))) {
      await client.query('ROLLBACK')
      return null
    }
    if (storedPhotos !== null) await replaceListingImages(client, listingId, storedPhotos)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const updated = await getListingById(listingId, { asHost: true })
  if (updated && requeue) await notifyListingRequeued(updated)
  return updated
}

// ---- Photos (listing_images) ------------------------------------------------
// Add / delete / reorder, each ownership-checked through listings.host_id and each
// re-queuing the listing — a photo change is exactly what a moderator looks at.

/** Does this host own this listing? (Row locked for the rest of the transaction.) */
async function ownsListing(client: PoolClient, listingId: string, hostUserId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM listings WHERE id = $1 AND host_id = $2 FOR UPDATE`,
    [listingId, hostUserId]
  )
  return (rowCount ?? 0) > 0
}

/** Re-queue for admin review inside an open transaction. Ownership re-checked. */
async function requeueListing(client: PoolClient, listingId: string, hostUserId: string): Promise<void> {
  await client.query(`UPDATE listings SET ${REQUEUE_SET} WHERE id = $1 AND host_id = $2`, [listingId, hostUserId])
}

/** Swap a listing's whole photo set — array order becomes display order (first = cover). */
async function replaceListingImages(client: PoolClient, listingId: string, urls: string[]): Promise<void> {
  await client.query(`DELETE FROM listing_images WHERE listing_id = $1`, [listingId])
  for (let i = 0; i < urls.length; i++) {
    await client.query(`INSERT INTO listing_images (listing_id, url, "order") VALUES ($1,$2,$3)`, [listingId, urls[i], i])
  }
}

/** Host appends photos to their own listing (kept under MAX_LISTING_PHOTOS) →
 *  re-queues for review. Returns the refreshed listing, or null if not theirs. */
export async function addListingImages(
  listingId: string,
  hostUserId: string,
  urls: unknown
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  const list = Array.isArray(urls) ? urls : [urls]
  if (!list.length) throw new ListingInputError('Please attach at least one photo')
  const validated = list.map((u) => assertImageSrc(u, 'Each photo must be an image'))
  // Bytes go to Blob BEFORE the transaction opens: an upload is network I/O and
  // must never run while this listing's row lock is held. What gets inserted is
  // the returned URL — see blob-store.ts.
  const photos = await storeListingPhotos(listingId, validated)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await ownsListing(client, listingId, hostUserId))) {
      await client.query('ROLLBACK')
      return null
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS count, COALESCE(max("order"), -1)::int AS max_order
         FROM listing_images WHERE listing_id = $1`,
      [listingId]
    )
    const { count, max_order } = rows[0] as { count: number; max_order: number }
    if (count + photos.length > MAX_LISTING_PHOTOS) {
      throw new ListingInputError(`A listing can have at most ${MAX_LISTING_PHOTOS} photos`)
    }
    for (let i = 0; i < photos.length; i++) {
      await client.query(
        `INSERT INTO listing_images (listing_id, url, "order") VALUES ($1,$2,$3)`,
        [listingId, photos[i], max_order + 1 + i]
      )
    }
    if (photosRequeue()) await requeueListing(client, listingId, hostUserId)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const updated = await getListingById(listingId, { asHost: true })
  if (updated && photosRequeue()) await notifyListingRequeued(updated)
  return updated
}

/** Host removes one photo from their own listing (the remaining orders are
 *  re-packed to 0..n-1, so the next photo becomes the cover) → re-queues for review. */
export async function deleteListingImage(
  listingId: string,
  hostUserId: string,
  imageId: string
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId) || !isUuid(imageId)) return null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Ownership via a join back to listings.host_id — the image id alone proves nothing.
    const { rowCount } = await client.query(
      `DELETE FROM listing_images li
        USING listings l
        WHERE li.id = $3 AND li.listing_id = $1 AND l.id = li.listing_id AND l.host_id = $2`,
      [listingId, hostUserId, imageId]
    )
    if (!rowCount) {
      await client.query('ROLLBACK')
      return null
    }
    // A listing needs a photo — the create door and the edit patch both refuse a
    // listing without one (listing-completeness-policy.ts), and removing them one
    // at a time from here is the same listing arriving at the same place. Counted
    // after the delete, inside the transaction, so the answer is the one this
    // statement actually produced; the ROLLBACK puts the photo back.
    const { rows: left } = await client.query(
      `SELECT count(*)::int AS count FROM listing_images WHERE listing_id = $1`,
      [listingId]
    )
    if ((left[0] as { count: number }).count < MIN_LISTING_PHOTOS) {
      await client.query('ROLLBACK')
      throw new ListingInputError(
        'A listing needs at least one photo — add another before removing this one'
      )
    }
    await client.query(
      `UPDATE listing_images li SET "order" = ranked.rn - 1
         FROM (SELECT id, row_number() OVER (ORDER BY "order", id) AS rn
                 FROM listing_images WHERE listing_id = $1) ranked
        WHERE li.id = ranked.id AND li."order" <> ranked.rn - 1`,
      [listingId]
    )
    if (photosRequeue()) await requeueListing(client, listingId, hostUserId)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const updated = await getListingById(listingId, { asHost: true })
  if (updated && photosRequeue()) await notifyListingRequeued(updated)
  return updated
}

/** Host reorders their own listing's photos — `orderedImageIds` must list every
 *  photo of the listing exactly once; index 0 becomes the cover. Re-queues for review. */
export async function reorderListingImages(
  listingId: string,
  hostUserId: string,
  orderedImageIds: unknown
): Promise<Listing | null> {
  if (!isUuid(listingId) || !isUuid(hostUserId)) return null
  if (!Array.isArray(orderedImageIds)) throw new ListingInputError('Photo order must be a list of photo ids')
  const ids = orderedImageIds.map((v) => String(v ?? '').trim())
  if (!ids.length || ids.some((v) => !isUuid(v))) throw new ListingInputError('Photo order must be a list of photo ids')
  if (new Set(ids).size !== ids.length) throw new ListingInputError('Each photo can appear only once in the order')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await ownsListing(client, listingId, hostUserId))) {
      await client.query('ROLLBACK')
      return null
    }
    const { rows } = await client.query(`SELECT id FROM listing_images WHERE listing_id = $1`, [listingId])
    const current = new Set((rows as { id: string }[]).map((r) => r.id))
    if (current.size !== ids.length || ids.some((id) => !current.has(id))) {
      throw new ListingInputError('The photo order must list every photo of this listing exactly once')
    }
    for (let i = 0; i < ids.length; i++) {
      await client.query(`UPDATE listing_images SET "order" = $3 WHERE id = $2 AND listing_id = $1`, [listingId, ids[i], i])
    }
    if (photosRequeue()) await requeueListing(client, listingId, hostUserId)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const updated = await getListingById(listingId, { asHost: true })
  if (updated && photosRequeue()) await notifyListingRequeued(updated)
  return updated
}

/** A host edit put this listing back in the moderation queue: tell the host it's
 *  hidden until approved (the same shape as createListing's "submitted for review")
 *  and ping every admin so the /ops queue is picked up. Best-effort — a
 *  notification failure never fails the edit. */
async function notifyListingRequeued(listing: Listing): Promise<void> {
  try {
    if (listing.host_id) {
      await createNotification(listing.host_id, {
        type: 'listing_submitted',
        title: 'Listing back under review',
        body: `“${listing.title}” was updated, so it’s under review again. It stays hidden from guests until an admin approves it.`,
        link: '/host',
      })
      await sendPush(listing.host_id, {
        title: 'Listing back under review',
        body: `${listing.title} — hidden from guests until approved`,
        link: '/host',
      })
    }
    const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'admin'`)
    for (const admin of rows as { id: string }[]) {
      await createNotification(admin.id, {
        type: 'listing_pending',
        title: 'Listing edited — needs review',
        body: `“${listing.title}” was edited by its host and is waiting for approval.`,
        link: '/ops',
      })
    }
  } catch (e) {
    console.error('notifyListingRequeued failed (ignored):', e)
  }
}

// ---- Stay guide (host-authored content on a confirmed booking) ---------------
// The host enriches a confirmed reservation with info blocks, photos, QR links to
// places and attachments; the guest sees them on the stay pass the QR opens.
// bookings.host_notes (free text) still works exactly as before — these are
// structured items alongside it.

export const STAY_GUIDE_KINDS = ['info', 'photo', 'place_qr', 'attachment'] as const
export type StayGuideKind = (typeof STAY_GUIDE_KINDS)[number]

export interface StayGuideItem {
  id: string
  kind: StayGuideKind
  title: string | null
  body: string | null
  url: string | null
  order: number
}

/** Display fields only — never the booking id or anything about the guest. The
 *  public stay page returns exactly this shape too. */
const GUIDE_COLS = `g.id::text AS id, g.kind, g.title, g.body, g.url, g."order"`
const GUIDE_ORDER = `ORDER BY g."order", g.created_at`

const MAX_GUIDE_ASSET = 3_500_000 // same cap as ownership docs / payment proofs
const MAX_GUIDE_TITLE = 120
const MAX_GUIDE_BODY = 4000
const MAX_GUIDE_LINK = 2000

/** One of the four item types, else a guest-readable error. */
function assertGuideKind(kind: unknown): StayGuideKind {
  const k = String(kind ?? '').trim().toLowerCase()
  if (!(STAY_GUIDE_KINDS as readonly string[]).includes(k)) {
    throw new Error('Choose a type: info, photo, place_qr or attachment')
  }
  return k as StayGuideKind
}

/** Host-typed text, capped and stored as PLAIN TEXT — it is rendered to strangers
 *  on the public pass, so every client escapes it (never dangerouslySetInnerHTML). */
function cleanGuideText(v: unknown, max: number): string | null {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, max) : null
}

/** Validate the item's URL for its kind (mirrors setListingOwnershipDoc):
 *   photo/attachment — an inline data: URL or an http(s) link, max ~3.5MB;
 *   place_qr        — a link the guest's phone will OPEN, so http(s) ONLY
 *                     (data: and javascript: are rejected);
 *   info            — carries no URL. */
function cleanGuideUrl(kind: StayGuideKind, url: unknown): string | null {
  const u = String(url ?? '').trim()
  if (kind === 'info') return null
  if (kind === 'place_qr') {
    if (!/^https?:\/\//i.test(u)) throw new Error('Please use a link starting with http:// or https://')
    if (u.length > MAX_GUIDE_LINK) throw new Error('That link is too long')
    return u
  }
  if (!/^(data:|https?:\/\/)/i.test(u)) {
    throw new Error(kind === 'photo' ? 'Please attach a photo' : 'Please attach a file')
  }
  if (u.length > MAX_GUIDE_ASSET) throw new Error('That file is too large (max ~3.5MB)')
  return u
}

/** Clamp the manual sort position. */
function clampGuideOrder(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.max(0, Math.min(9999, n)) : null
}

export interface StayGuideInput {
  kind: unknown
  title?: unknown
  body?: unknown
  url?: unknown
  order?: unknown
}

/** The booking's guide items. Read side only — callers authorize first. */
async function getStayGuideItems(bookingId: string): Promise<StayGuideItem[]> {
  const { rows } = await pool.query(
    `SELECT ${GUIDE_COLS} FROM stay_guide_items g WHERE g.booking_id = $1 ${GUIDE_ORDER}`,
    [bookingId]
  )
  return rows as StayGuideItem[]
}

/** The guide for a reservation, for the booking's guest, the listing's host, or
 *  an admin — else null (same authorization shape as getBookingProof). */
export async function listStayGuide(
  bookingId: string,
  requester: { id: string; role: string },
): Promise<StayGuideItem[] | null> {
  if (!isUuid(bookingId)) return null
  const auth = await pool.query(
    `SELECT b.user_id, l.host_id FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`,
    [bookingId]
  )
  const a = auth.rows[0]
  if (!a) return null
  const allowed = requester.role === 'admin' || requester.id === a.user_id || requester.id === a.host_id
  if (!allowed) return null
  return getStayGuideItems(bookingId)
}

/**
 * Host adds an item to one of THEIR confirmed bookings. Ownership + the confirmed
 * gate live in the INSERT ... SELECT itself, so a client-supplied host id can
 * never widen it: no matching (booking, host) row → no insert → null.
 * Omitting `order` appends the item to the end of the guide.
 */
export async function addStayGuideItem(
  bookingId: string,
  hostUserId: string,
  input: StayGuideInput,
): Promise<StayGuideItem | null> {
  if (!isUuid(bookingId) || !isUuid(hostUserId)) return null
  const kind = assertGuideKind(input.kind)
  const title = cleanGuideText(input.title, MAX_GUIDE_TITLE)
  const body = cleanGuideText(input.body, MAX_GUIDE_BODY)
  const url = cleanGuideUrl(kind, input.url)
  if (kind === 'info' && !title && !body) throw new Error('Add a title or some text for this item')
  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO stay_guide_items (booking_id, kind, title, body, url, "order")
       SELECT b.id, $3, $4, $5, $6,
              COALESCE($7::int, (SELECT COALESCE(max(x."order"), -1) + 1 FROM stay_guide_items x WHERE x.booking_id = b.id))
         FROM bookings b JOIN listings l ON l.id = b.listing_id
        WHERE b.id = $1 AND l.host_id = $2 AND b.status = 'confirmed'
       RETURNING *
     )
     SELECT ${GUIDE_COLS} FROM ins g`,
    [bookingId, hostUserId, kind, title, body, url, clampGuideOrder(input.order)]
  )
  return (rows[0] as StayGuideItem) ?? null
}

/** Host edits / reorders one of their items. `kind` is immutable (delete + re-add
 *  to change it) so the URL rules can't be swapped out from under an item.
 *  Only the fields present in `patch` change; ownership is enforced in the SQL. */
export async function updateStayGuideItem(
  bookingId: string,
  itemId: string,
  hostUserId: string,
  patch: { title?: unknown; body?: unknown; url?: unknown; order?: unknown },
): Promise<StayGuideItem | null> {
  if (!isUuid(bookingId) || !isUuid(itemId) || !isUuid(hostUserId)) return null
  // The item's own kind decides how a new URL is validated.
  const cur = await pool.query(
    `SELECT g.kind FROM stay_guide_items g
       JOIN bookings b ON b.id = g.booking_id
       JOIN listings l ON l.id = b.listing_id
      WHERE g.id = $1 AND b.id = $2 AND l.host_id = $3`,
    [itemId, bookingId, hostUserId]
  )
  if (!cur.rows[0]) return null
  const kind = cur.rows[0].kind as StayGuideKind
  const hasTitle = patch.title !== undefined
  const hasBody = patch.body !== undefined
  const hasUrl = patch.url !== undefined && kind !== 'info'
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE stay_guide_items g SET
         title = CASE WHEN $4::boolean THEN $5 ELSE g.title END,
         body  = CASE WHEN $6::boolean THEN $7 ELSE g.body END,
         url   = CASE WHEN $8::boolean THEN $9 ELSE g.url END,
         "order" = COALESCE($10::int, g."order")
       FROM bookings b, listings l
       WHERE g.id = $1 AND g.booking_id = b.id AND b.id = $2
         AND l.id = b.listing_id AND l.host_id = $3
       RETURNING g.*
     )
     SELECT ${GUIDE_COLS} FROM upd g`,
    [
      itemId, bookingId, hostUserId,
      hasTitle, hasTitle ? cleanGuideText(patch.title, MAX_GUIDE_TITLE) : null,
      hasBody, hasBody ? cleanGuideText(patch.body, MAX_GUIDE_BODY) : null,
      hasUrl, hasUrl ? cleanGuideUrl(kind, patch.url) : null,
      clampGuideOrder(patch.order),
    ]
  )
  return (rows[0] as StayGuideItem) ?? null
}

/** Host removes one of their items. True if a row was deleted. */
export async function deleteStayGuideItem(
  bookingId: string,
  itemId: string,
  hostUserId: string,
): Promise<boolean> {
  if (!isUuid(bookingId) || !isUuid(itemId) || !isUuid(hostUserId)) return false
  const { rowCount } = await pool.query(
    `DELETE FROM stay_guide_items g
      USING bookings b, listings l
      WHERE g.id = $1 AND g.booking_id = b.id AND b.id = $2
        AND l.id = b.listing_id AND l.host_id = $3`,
    [itemId, bookingId, hostUserId]
  )
  return (rowCount ?? 0) > 0
}

export interface StayPass {
  reservation_code: string | null
  title: string
  location: string | null
  region: string | null
  check_in: string
  check_out: string
  guests: number
  status: string
  payment_status: string
  host_notes: string | null
  guest_name: string | null
  host_name: string | null
  image: string | null
  /** Host-authored guide items (empty unless the stay is confirmed/completed). */
  guide: StayGuideItem[]
}

/** Normalize a code coming off a QR / URL segment. Returns null when there is no
 *  usable code — including the literal "null"/"undefined" that a client with an
 *  unconfirmed booking may have stringified into the link. A pending booking has
 *  reservation_code NULL, so it can never be reached by code at all. */
export function normalizeStayCode(code: unknown): string | null {
  const c = String(code ?? '').trim().toUpperCase()
  if (!c || c === 'NULL' || c === 'UNDEFINED' || c === 'NONE') return null
  return c
}

/** Public stay "pass" data, looked up by the reservation code embedded in the
 *  QR. Returns only non-sensitive fields (no emails/phones, no ids) so the QR
 *  link is safe to open by anyone holding the code. */
export async function getStayByCode(code: string): Promise<StayPass | null> {
  const c = normalizeStayCode(code)
  if (!c) return null
  const { rows } = await pool.query(
    `SELECT b.id, b.reservation_code,
            l.title, l.location, l.region,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.guests, b.status, COALESCE(b.payment_status, 'unpaid') AS payment_status,
            b.host_notes,
            (SELECT split_part(u.full_name, ' ', 1) FROM users u WHERE u.id = b.user_id) AS guest_name,
            (SELECT u.full_name FROM users u WHERE u.id = l.host_id) AS host_name,
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS image
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.reservation_code IS NOT NULL AND upper(b.reservation_code) = $1 LIMIT 1`,
    [c]
  )
  const row = rows[0] as (Omit<StayPass, 'guide'> & { id: string }) | undefined
  if (!row) return null
  const { id, ...pass } = row
  // The guide belongs to a live stay: once cancelled/rejected the host's content
  // (gate codes, directions…) stops being served. Best-effort so a dev DB without
  // the table still renders the pass.
  let guide: StayGuideItem[] = []
  if (pass.status === 'confirmed' || pass.status === 'completed') {
    try {
      guide = await getStayGuideItems(id)
    } catch (e) {
      console.error('stay guide unavailable (run the stay_guide_items migration):', e)
    }
  }
  return { ...pass, guide }
}

// ---- Reservation lifecycle: host listings + booking confirmation -------------

/** THE reservation-code generator — one format for every surface (backend, web,
 *  iOS, Android): "QK-" + 6 chars from an alphabet with no ambiguous glyphs, e.g.
 *  "QK-7F3K9Q". Never derive a code from the booking id; the stored column is the
 *  only truth, and it is written exactly once, at confirmation (see issueCodeSql). */
export function genReservationCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
  let s = ''
  for (let i = 0; i < 6; i++) s += alphabet[randomInt(0, alphabet.length)]
  return `QK-${s}`
}

export interface CreateListingInput {
  title: string
  description?: string
  location?: string
  country?: string
  pricePerNight: number
  bedrooms?: number
  beds?: number
  bathrooms?: number
  maxGuests?: number
  propertyType?: string
  region?: string
  /** Resort picked from the catalog. Wins over resortName. */
  resortId?: string | null
  /** Free text the host typed via "Other". Queued for admin review. */
  resortName?: string | null
  lat?: number
  lng?: number
  images?: string[]
  amenities?: string[]
  cancellationPolicy?: string
  ownershipDoc?: string
  weeklyDiscount?: number
  monthlyDiscount?: number
  weekendPrice?: number | null
  monthlyPrices?: unknown
}

/** Clamp a percent discount to 0..90 (integers). */
function clampDiscount(v: unknown): number {
  const n = Math.floor(Number(v) || 0)
  return Math.max(0, Math.min(90, n))
}

/** A positive nightly price, or null. */
function cleanPrice(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** Keep only months "1".."12" → positive price. Returns a JSON string for jsonb. */
function cleanMonthlyPrices(v: unknown): string {
  const out: Record<string, number> = {}
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const m = Number(k)
      const p = cleanPrice(val)
      if (Number.isInteger(m) && m >= 1 && m <= 12 && p) out[String(m)] = p
    }
  }
  return JSON.stringify(out)
}

/** A host (or admin) creates a listing. Returns the full listing with images. */
export async function createListing(hostUserId: string, input: CreateListingInput): Promise<Listing> {
  if (!isUuid(hostUserId)) throw new Error('Invalid host id')
  // A title is what the listing IS everywhere it appears — the explore card, the
  // search result, the booking request. A non-empty check published `12345` and
  // `@@@@@` as a listing's name; listing-title-policy is what decides now, and it
  // is the same file the web repo runs, so the two doors onto this one database
  // cannot disagree about what a listing may be called.
  const title = assertListingTitle(input.title)
  const price = Number(input.pricePerNight)
  if (!Number.isFinite(price) || price <= 0) throw new Error('Price must be a positive number')
  // A title and a price were the WHOLE bar on both doors onto this table: a
  // listing was created with no description, no address, no area, no map pin and
  // no photos, and neither the web form nor either mobile wizard said otherwise.
  // listing-completeness-policy.ts is byte-identical to the web repo's copy
  // (check-listing-completeness-policy-parity.mjs keeps it that way), so the
  // phone and the website cannot disagree about what a listing must say.
  const incomplete = checkListingCompleteness({
    description: input.description,
    location: input.location,
    region: input.region,
    resort_id: input.resortId,
    resort_name: input.resortName,
    lat: input.lat,
    lng: input.lng,
    property_type: input.propertyType,
    images: input.images,
  })
  if (incomplete) throw new ListingInputError(listingCompletenessProblemMessage(incomplete))
  // A number in the listing copy reaches every guest at once, so the same guard
  // the chat runs applies to the fields a host writes freely.
  await guardContent(hostUserId, title, 'listing')
  await guardContent(hostUserId, input.description ?? '', 'listing')

  // New listings enter the moderation queue: unpublished + 'pending' until an
  // admin approves them (S7). Ownership doc (if provided) is stored for review.
  // Unlike the edit paths this one does NOT refuse the listing over a bad
  // document — create has always stored what it could and left the rest to the
  // moderation queue, and a host who attaches nothing usable simply lands there
  // with no document to review.
  const ownershipDoc = checkOwnershipDoc(input.ownershipDoc) === null ? String(input.ownershipDoc).trim() : null
  // The resort decides the region — that is the point of a resort belonging to one.
  // An unknown typed name is kept as free text AND queued for /ops.
  assertResortName(input.resortId, input.resortName)
  const resort = await resolveResortSelection({
    resortId: input.resortId,
    resortName: input.resortName,
    region: input.region ?? null,
    userId: hostUserId,
  })
  // The map pin. Create used to write whatever arrived straight into the column,
  // so a latitude of 999 was stored here while the patch path (assertCoord) had
  // always refused it. Whether the pin agrees with the country and region the
  // host chose is a softer question answered by listing-geo-policy.ts — the route
  // returns it as a warning and never refuses the listing over it.
  const lat = input.lat === undefined ? null : assertCoord(input.lat, 'Latitude', 90)
  const lng = input.lng === undefined ? null : assertCoord(input.lng, 'Longitude', 180)
  const { rows } = await pool.query(
    `INSERT INTO listings
       (host_id, title, description, location, country, price_per_night, currency,
        bedrooms, beds, bathrooms, max_guests, property_type, region, lat, lng, listing_code, is_published, amenities,
        cancellation_policy, approval_status, ownership_doc, weekly_discount, monthly_discount, weekend_price, monthly_prices,
        resort_id, resort_name)
     VALUES ($1,$2,$3,$4,$5,$6,'EGP',$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16,$17,'pending',$18,$19,$20,$21,$22::jsonb,$23,$24)
     RETURNING id`,
    [
      hostUserId, title, input.description ?? null, input.location ?? null, input.country ?? null,
      price, Math.max(0, Math.floor(input.bedrooms ?? 1)), Math.max(0, Math.floor(input.beds ?? 1)),
      Math.max(0, Math.floor(input.bathrooms ?? 1)), Math.max(1, Math.floor(input.maxGuests ?? 2)),
      input.propertyType ?? 'Apartment', resort.region, lat, lng, genReservationCode(),
      input.amenities ?? [], normalizePolicy(input.cancellationPolicy), ownershipDoc,
      clampDiscount(input.weeklyDiscount), clampDiscount(input.monthlyDiscount),
      cleanPrice(input.weekendPrice), cleanMonthlyPrices(input.monthlyPrices),
      resort.resort_id, resort.resort_name,
    ]
  )
  const id = rows[0].id as string
  const images = (input.images ?? []).filter((u) => typeof u === 'string' && u.trim()).slice(0, 10)
  // The listing row exists, so its id can group the photos in Blob. Uploaded
  // here rather than inline in the loop so all of them go up concurrently.
  const storedImages = await storeListingPhotos(id, images.map((u) => u.trim()))
  for (let i = 0; i < storedImages.length; i++) {
    await pool.query(`INSERT INTO listing_images (listing_id, url, "order") VALUES ($1,$2,$3)`, [id, storedImages[i], i])
  }
  const created = await getListingById(id, { asHost: true })
  if (!created) throw new Error('Failed to create listing')
  // New listings await admin approval before going live (S7).
  await createNotification(hostUserId, {
    type: 'listing_submitted',
    title: 'Listing submitted for review',
    body: `“${created.title}” is under review. We’ll let you know once it’s approved.`,
    link: '/host',
  })
  await sendPush(hostUserId, {
    title: 'Listing submitted for review',
    body: `${created.title} — pending approval`,
    link: '/host',
  })
  return created
}

/** A host's own listings — raw prices, plus guest_* for "guests pay X". */
export async function getHostListings(hostUserId: string): Promise<Listing[]> {
  if (!isUuid(hostUserId)) return []
  const { rows } = await pool.query(
    `SELECT ${LISTING_COLS_HOST} FROM listings l WHERE l.host_id = $1 ORDER BY l.created_at DESC`,
    [hostUserId]
  )
  return rows as Listing[]
}

/** Host confirms or rejects a PENDING booking for one of THEIR listings. Returns null if not allowed. */
export async function setBookingStatus(
  bookingId: string,
  hostUserId: string,
  status: 'confirmed' | 'rejected'
): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(hostUserId)) return null
  // Approving is THE confirmation transition — the reservation code (and with it the
  // guest's QR / wallet pass / stay link) is born here. Declining leaves it NULL.
  await pool.query(
    `UPDATE bookings b SET status = $3,
            ${issueCodeSql(`$3 = 'confirmed'`, '$4')},
            -- B3: the cancelled_* columns record who ENDED a booking, for any
            -- terminal transition. A host cannot "cancel" in this system — declining
            -- a pending request is their only termination — so it is attributed here
            -- as role 'host'. Without this the cancellation report could never show
            -- a host at all.
            cancelled_at      = CASE WHEN $3 = 'rejected' THEN COALESCE(b.cancelled_at, now()) ELSE b.cancelled_at END,
            cancelled_by      = CASE WHEN $3 = 'rejected' THEN $2::text ELSE b.cancelled_by END,
            cancelled_by_role = CASE WHEN $3 = 'rejected' THEN 'host' ELSE b.cancelled_by_role END
       FROM listings l
      WHERE b.id = $1 AND b.listing_id = l.id AND l.host_id = $2 AND b.status = 'pending'`,
    [bookingId, hostUserId, status, genReservationCode()]
  )
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.id = $1 AND l.host_id = $2`,
    [bookingId, hostUserId]
  )
  const updated = (rows[0] as Booking) ?? null
  // Notify the guest that the host confirmed/declined their request — in-app + push + email.
  if (updated) {
    const confirmed = status === 'confirmed'
    await createNotification(updated.user_id, {
      type: `booking_${status}`,
      title: confirmed ? 'Reservation confirmed' : 'Reservation declined',
      body: `Your stay at ${updated.title}`,
      link: `/reservation/${updated.id}`,
    })
    await sendPush(updated.user_id, {
      title: confirmed ? 'Reservation confirmed 🎉' : 'Reservation update',
      body: confirmed ? `Your stay at ${updated.title} is confirmed` : `Your request for ${updated.title} wasn’t accepted`,
      link: `/reservation/${updated.id}`,
    })
    const guestEmail = await userEmail(updated.user_id)
    if (guestEmail) {
      if (confirmed) {
        await sendNotificationEmail(
          guestEmail,
          'Your reservation is confirmed 🎉 — QuickIn',
          'Your stay is confirmed',
          [
            `Your reservation at <strong>${updated.title}</strong> is confirmed.`,
            `Dates: ${updated.check_in} → ${updated.check_out}.`,
            `Reservation code: <strong>${updated.reservation_code ?? ''}</strong>.`,
          ],
          { label: 'View reservation', url: `${WEB_URL}/reservation/${updated.id}` }
        )
      } else {
        await sendNotificationEmail(
          guestEmail,
          'Update on your reservation — QuickIn',
          'Your request wasn’t accepted',
          [
            `Unfortunately your request for <strong>${updated.title}</strong> wasn’t accepted this time.`,
            'There are plenty of other boutique stays waiting for you.',
          ],
          { label: 'Explore stays', url: `${WEB_URL}/explore` }
        )
      }
    }
  }
  return updated
}

/** All bookings across a host's listings (host "requests" view). Host-only, so
 *  it also carries `host_payout` — the raw amount this host is owed, which the
 *  shared projection deliberately withholds. */
export async function getHostBookings(hostUserId: string): Promise<Booking[]> {
  if (!isUuid(hostUserId)) return []
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS}, b.total_price::float8 AS host_payout
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE l.host_id = $1 ORDER BY b.created_at DESC`,
    [hostUserId]
  )
  return rows as Booking[]
}

/** A single reservation (for the detail card / QR / wallet pass). */
export async function getBookingById(bookingId: string): Promise<Booking | null> {
  if (!isUuid(bookingId)) return null
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`,
    [bookingId]
  )
  return (rows[0] as Booking) ?? null
}

// ---- Instapay manual payment (app_settings + payment_proofs) -----------------
// Flow: guest transfers via Instapay, uploads a screenshot at booking time
// (payment 'submitted') → host accepts (confirmed + paid) or rejects → guest may
// dispute a rejection → admin resolves. See scripts/migrate-instapay.mjs.

const MAX_PROOF_BYTES = 3_500_000

/** Validate a base64 data-URL (or https URL) screenshot, matching the id_verifications convention. */
function assertProofImage(src: unknown): string {
  const v = String(src ?? '').trim()
  if (!/^data:image\//i.test(v) && !/^https?:\/\//i.test(v)) {
    throw new Error('Please attach a screenshot of your transfer')
  }
  if (v.length > MAX_PROOF_BYTES) throw new Error('That screenshot is too large (max ~3.5MB)')
  return v
}

/** Read one admin setting (null if unset). */
export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key])
  return rows[0] ? ((rows[0].value as string | null) ?? null) : null
}

/** Upsert an admin setting. `updatedBy` is a user id or 'admin' (free text). */
export async function setSetting(key: string, value: string, updatedBy: string | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, value, updatedBy]
  )
}

// ---- Platform commission -----------------------------------------------------

export interface CommissionConfig {
  /** Fraction, e.g. 0.1 = 10%. */
  rate: number
  /** The same value as the percentage the admin form edits, e.g. 10. */
  percent: number
  updated_at: string | null
  updated_by: string | null
}

/** The live commission rate and who last changed it (the /ops/pricing screen). */
export async function getCommissionConfig(): Promise<CommissionConfig> {
  const { rows } = await pool.query(
    `SELECT value, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at, updated_by
       FROM app_settings WHERE key = $1`,
    [COMMISSION_RATE_KEY]
  )
  const rate = parseRate(rows[0]?.value)
  return {
    rate,
    percent: Math.round(rate * 10_000) / 100,
    updated_at: rows[0]?.updated_at ?? null,
    updated_by: rows[0]?.updated_by ?? null,
  }
}

/** Write a validated rate (a fraction — validate with rateFromPercent first). */
export async function setCommissionRate(rate: number, updatedBy: string | null = null): Promise<CommissionConfig> {
  await setSetting(COMMISSION_RATE_KEY, rateToStored(rate), updatedBy)
  return getCommissionConfig()
}

/**
 * Every guest-facing way to pay, in one read: the Instapay destination (handle,
 * optional deep link, optional uploaded QR) and the bank-transfer destination
 * (bank, account holder, account number, optional IBAN), each with its own
 * on/off toggle, plus the derived `available_methods` a client renders a picker
 * from.
 *
 * Rows that were never saved read as '' — **no migration is needed to add a
 * key**, which is why the bank destination ships without one. An absent toggle
 * row reads as ON (see storedToBool), so a database that predates this never
 * goes dark; an empty destination is hidden by `configured` instead.
 */
export async function getPaymentConfig(): Promise<PaymentConfig> {
  const { rows } = await pool.query(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
    [PAYMENT_SETTING_KEYS]
  )
  return rowsToPaymentConfig(rows as Array<{ key: string; value: string | null }>)
}

/**
 * Guest uploads a transfer screenshot for their booking. Inserts a payment_proofs
 * row, flips payment_status → 'submitted', and (if the host had rejected) reopens
 * the booking to 'pending' for re-review. Only the booking's owner, never on an
 * already-paid booking. Returns the updated booking (or null if not theirs).
 */
export async function submitPaymentProof(
  bookingId: string,
  userId: string,
  imageData: string,
  method = 'instapay',
): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(userId)) return null
  const img = assertProofImage(imageData)
  // Constrained to the shared vocabulary rather than any 32-char string: this
  // value labels the row in the ops queue, and a reviewer needs to know which
  // account to check the money landed in. An unknown value falls back to
  // 'instapay' — see normalizePaymentMethod.
  const m = normalizePaymentMethod(method)
  const cur = await pool.query(
    `SELECT payment_status FROM bookings WHERE id = $1 AND user_id = $2`,
    [bookingId, userId]
  )
  if (!cur.rows[0]) return null
  if (cur.rows[0].payment_status === 'paid') throw new Error('This booking is already paid')

  await pool.query(
    `INSERT INTO payment_proofs (booking_id, method, image_data, amount)
     VALUES ($1, $2, $3, (SELECT total_price FROM bookings WHERE id = $1))`,
    [bookingId, m, img]
  )
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET
         payment_status = 'submitted',
         payment_method = $3,
         status = CASE WHEN b.status = 'rejected' THEN 'pending' ELSE b.status END
       WHERE b.id = $1 AND b.user_id = $2
       RETURNING b.*
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, userId, m]
  )
  const booking = (rows[0] as Booking) ?? null
  if (booking) {
    // The GUEST is told their part is done. This used to notify only the host, with
    // "Payment to review" and a link to /host — but hosts no longer confirm transfers
    // (the money goes to QuickIn's account, and an admin decides), so that message
    // asked them to do something they can't. The host is still told money arrived.
    await createNotification(userId, {
      type: 'payment_submitted',
      title: 'Transfer received',
      body: `We got your screenshot for ${booking.title}. We'll confirm it shortly.`,
      link: '/reservations',
    })
    if (booking.host_id) {
      await createNotification(booking.host_id, {
        type: 'payment_submitted',
        title: 'Guest sent a payment',
        body: `${booking.title} — QuickIn is confirming the transfer`,
        link: '/host',
      })
      await sendPush(booking.host_id, {
        title: 'Guest sent a payment',
        body: `${booking.title} — ${booking.reservation_code ?? ''}`,
        link: '/host',
      })
    }
  }
  return booking
}

export interface PaymentProof {
  image_data: string
  method: string
  status: string
  submitted_at: string
  reject_reason: string | null
  dispute_note: string | null
  amount: number | null
}

/** The latest transfer screenshot for a booking. Authorized to the booking's
 *  guest, the listing's host, or an admin — else null. */
export async function getBookingProof(
  bookingId: string,
  requester: { id: string; role: string },
): Promise<PaymentProof | null> {
  if (!isUuid(bookingId)) return null
  const auth = await pool.query(
    `SELECT b.user_id, l.host_id FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`,
    [bookingId]
  )
  const a = auth.rows[0]
  if (!a) return null
  const allowed = requester.role === 'admin' || requester.id === a.user_id || requester.id === a.host_id
  if (!allowed) return null
  const { rows } = await pool.query(
    `SELECT image_data, method, status,
            to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
            reject_reason, dispute_note, amount::float8 AS amount
       FROM payment_proofs WHERE booking_id = $1 ORDER BY payment_proofs.submitted_at DESC LIMIT 1`,
    [bookingId]
  )
  return (rows[0] as PaymentProof) ?? null
}

/**
 * Host accepts or rejects a booking's payment (doubles as accepting the stay).
 * Accept → booking 'confirmed' + payment 'paid'. Reject → 'rejected' + reason.
 * Only the listing's host, only while the booking is 'pending'. Updates the
 * latest proof row and notifies the guest. Returns null if not the host / not pending.
 */
// hostReviewPayment was removed with the payment-flow change: hosts no longer approve
// transfers, an admin does (adminReviewProof). It was also unreachable in practice —
// it required b.status = 'pending' while a guest can only pay once a booking is
// 'confirmed', so a normal screenshot could never be approved through it.
export async function guestDisputePayment(
  bookingId: string,
  userId: string,
  note: string | null = null,
): Promise<Booking | null> {
  if (!isUuid(bookingId) || !isUuid(userId)) return null
  const latest = await pool.query(
    `SELECT pp.id, pp.status FROM payment_proofs pp
       JOIN bookings b ON b.id = pp.booking_id
      WHERE pp.booking_id = $1 AND b.user_id = $2
      ORDER BY pp.submitted_at DESC LIMIT 1`,
    [bookingId, userId]
  )
  const l = latest.rows[0]
  if (!l) return null
  if (l.status !== 'rejected') throw new Error('Only a rejected payment can be disputed')
  await pool.query(
    `UPDATE payment_proofs SET status = 'disputed', dispute_note = $2, disputed_at = now() WHERE id = $1`,
    [l.id, note ? String(note).slice(0, 1000) : null]
  )
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET payment_status = 'disputed' WHERE b.id = $1 AND b.user_id = $2 RETURNING b.*
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, userId]
  )
  return (rows[0] as Booking) ?? null
}

export interface DisputeRow {
  booking_id: string
  reservation_code: string | null
  title: string
  guest_id: string
  guest_name: string | null
  guest_email: string | null
  host_id: string | null
  total_price: number
  /** Which destination the guest says they sent to — see PAYMENT_METHODS. */
  method: string | null
  reject_reason: string | null
  dispute_note: string | null
  submitted_at: string | null
  disputed_at: string | null
}

/** All open payment disputes (latest proof still 'disputed'), for the admin queue. */
export async function adminListDisputes(): Promise<DisputeRow[]> {
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, b.reservation_code, l.title,
            b.user_id AS guest_id,
            (SELECT full_name FROM users u WHERE u.id = b.user_id) AS guest_name,
            (SELECT email     FROM users u WHERE u.id = b.user_id) AS guest_email,
            l.host_id, b.total_price::float8 AS total_price,
            pp.method, pp.reject_reason, pp.dispute_note,
            to_char(pp.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
            to_char(pp.disputed_at AT TIME ZONE 'UTC',  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS disputed_at
       FROM payment_proofs pp
       JOIN bookings b ON b.id = pp.booking_id
       JOIN listings l ON l.id = b.listing_id
      WHERE pp.status = 'disputed'
        AND pp.id = (SELECT id FROM payment_proofs p2 WHERE p2.booking_id = pp.booking_id ORDER BY p2.submitted_at DESC LIMIT 1)
      ORDER BY pp.disputed_at DESC NULLS LAST`
  )
  return rows as DisputeRow[]
}

/** Admin resolves a dispute. Approve → confirm + mark paid; Uphold → keep rejected.
 *  Not constrained to 'pending' (a rejected booking can be revived). Notifies guest (+ host on approve). */
export async function adminResolveDispute(
  bookingId: string,
  adminId: string,
  action: 'approve' | 'uphold',
  note: string | null = null,
): Promise<Booking | null> {
  if (!isUuid(bookingId)) return null
  const approve = action === 'approve'
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE bookings b SET
         status = CASE WHEN $2 THEN 'confirmed' ELSE 'rejected' END,
         payment_status = CASE WHEN $2 THEN 'paid' ELSE 'rejected' END,
         paid_at = CASE WHEN $2 THEN COALESCE(b.paid_at, now()) ELSE b.paid_at END,
         -- Upholding the guest ("I did pay") confirms the stay → issue the code.
         ${issueCodeSql('$2', '$3')}
       WHERE b.id = $1
       RETURNING b.*
     )
     SELECT ${BOOKING_COLS} FROM upd b JOIN listings l ON l.id = b.listing_id`,
    [bookingId, approve, genReservationCode()]
  )
  const booking = (rows[0] as Booking) ?? null
  if (!booking) return null
  await pool.query(
    `UPDATE payment_proofs SET
        status = CASE WHEN $2 THEN 'approved' ELSE 'rejected' END,
        reviewed_by = $3, reviewed_at = now(),
        reject_reason = CASE WHEN $2 THEN NULL ELSE COALESCE($4, reject_reason) END
      WHERE id = (SELECT id FROM payment_proofs WHERE booking_id = $1 ORDER BY submitted_at DESC LIMIT 1)`,
    [bookingId, approve, String(adminId).slice(0, 64), note ? String(note).slice(0, 500) : null]
  )
  await createNotification(booking.user_id, {
    type: approve ? 'payment_approved' : 'payment_rejected',
    title: approve ? 'Payment confirmed' : 'Payment dispute closed',
    body: approve
      ? `Your stay at ${booking.title} is confirmed`
      : `${booking.title}: the transfer could not be verified`,
    link: `/reservation/${booking.id}`,
  })
  await sendPush(booking.user_id, {
    title: approve ? 'Booking confirmed 🎉' : 'Payment update',
    body: booking.title,
    link: `/reservation/${booking.id}`,
  })
  if (approve && booking.host_id) {
    await createNotification(booking.host_id, {
      type: 'booking_paid',
      title: 'Booking paid',
      body: `${booking.title} — payment confirmed by admin`,
      link: '/host',
    })
  }
  return booking
}

// ---- Host applications ("become a host" → admin review → approve) -----------
// Mirrors the web's helpers (quickin-master/src/lib/local/db.ts) so both projects
// behave identically against the shared Neon DB. Applying NEVER grants hosting —
// only an admin approval flips users.is_host.

export const HOST_TYPES = ['individual', 'company', 'brokerage'] as const
export type HostType = (typeof HOST_TYPES)[number]

/** Derived host state every client reads on launch to gate host surfaces. */
export type HostStatus = 'none' | 'pending' | 'rejected' | 'approved'

export interface HostState {
  is_host: boolean
  host_type: string | null
  host_status: HostStatus
  host_review_note: string | null
}

export interface HostApplication {
  id: string
  user_id: string
  email?: string
  full_name: string | null
  national_id: string | null
  phone: string | null
  address: string | null
  company: string | null
  host_type: string | null
  notes: string | null
  status: 'pending' | 'approved' | 'rejected'
  submitted_at: string
  reviewed_at: string | null
  review_note: string | null
}

// host_applications has no host_type column (canonical schema) — the choice is
// persisted on users.host_type at apply time and read back through the join.
const HOST_APP_COLS = `a.id, a.user_id, a.full_name, a.national_id, a.phone, a.address, a.company,
            u.host_type, a.notes, a.status,
            to_char(a.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
            to_char(a.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
            a.review_note`

/** Legacy rule: is_host = true ALWAYS means approved, even with no application
 *  row, so pre-existing hosts keep working. Conversely 'approved' is never taken
 *  from the application alone — users.is_host is the only source of host access. */
function deriveHostStatus(isHost: boolean, appStatus: string | null): HostStatus {
  if (isHost) return 'approved'
  if (appStatus === 'pending') return 'pending'
  if (appStatus === 'rejected') return 'rejected'
  return 'none'
}

function hostStateOf(isHost: boolean, hostType: string | null, appStatus: string | null, note: string | null): HostState {
  const status = deriveHostStatus(isHost, appStatus)
  return {
    is_host: isHost,
    host_type: hostType ?? null,
    host_status: status,
    host_review_note: status === 'rejected' ? (note ?? null) : null, // the note only ever explains a rejection
  }
}

/** The authoritative host fields for a user — returned by /api/auth/me and every
 *  auth response so a client can validate host access on each launch. */
export async function getHostState(userId: string): Promise<HostState> {
  const none: HostState = { is_host: false, host_type: null, host_status: 'none', host_review_note: null }
  if (!isUuid(userId)) return none
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(u.is_host, false) AS is_host, u.host_type, a.status, a.review_note
         FROM users u LEFT JOIN host_applications a ON a.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    )
    const r = rows[0]
    return r ? hostStateOf(Boolean(r.is_host), r.host_type, r.status, r.review_note) : none
  } catch (e) {
    // host_applications is absent on an old dev DB — fall back to users.is_host
    // alone so sign-in never breaks and legacy hosts still read as approved.
    console.error('getHostState fell back to users.is_host:', e)
    const { rows } = await pool.query(`SELECT COALESCE(is_host, false) AS is_host, host_type FROM users WHERE id = $1`, [userId])
    const r = rows[0]
    return r ? hostStateOf(Boolean(r.is_host), r.host_type, null, null) : none
  }
}

/** Spread the host fields onto a user payload so login / verify-otp / social all
 *  return exactly the shape /api/auth/me does. */
export async function withHostState<T extends { id: string }>(user: T): Promise<T & HostState> {
  return { ...user, ...(await getHostState(user.id)) }
}

/** The signed-in user's application, or null when they never applied. */
export async function getHostApplication(userId: string): Promise<HostApplication | null> {
  if (!isUuid(userId)) return null
  const { rows } = await pool.query(
    `SELECT ${HOST_APP_COLS}
       FROM host_applications a JOIN users u ON u.id = a.user_id
      WHERE a.user_id = $1`,
    [userId]
  )
  return (rows[0] as HostApplication) ?? null
}

/** Submit (or re-submit after a rejection) an application: upserts on the
 *  UNIQUE (user_id) constraint, back to 'pending' with the old review cleared.
 *  Does NOT touch users.is_host. Callers validate the fields first.
 *
 *  The identity documents ride along and are filed as the applicant's pending
 *  id_verifications row, linked through host_applications.verification_id, so
 *  ONE admin decision covers both host status and identity — and so no
 *  application reaches the queue with nothing for the reviewer to read the
 *  declared name and national ID against. An applicant who already has a
 *  verified or pending submission is linked to it instead of photographing the
 *  same document twice (`needsIdentityDocuments`); the route enforces the same
 *  rule up front so the applicant gets per-field messages. */
export async function submitHostApplication(
  userId: string,
  f: {
    full_name: string
    national_id: string
    phone: string
    address: string
    host_type: HostType
    company?: string | null
    notes?: string | null
    /** national_id | passport | residence_permit — which document was photographed. */
    doc_type?: string | null
    /** FRONT / BACK photos as `data:image/…` URLs (or https links). */
    id_front?: string | null
    id_back?: string | null
  }
): Promise<HostApplication | null> {
  if (!isUuid(userId)) throw new Error('Invalid user')
  const company = f.host_type === 'individual' ? null : (f.company || null)
  const vals = [userId, f.full_name, f.national_id, f.phone, f.address, company, f.notes || null]
  const upd = await pool.query(
    `UPDATE host_applications
        SET full_name = $2, national_id = $3, phone = $4, address = $5, company = $6, notes = $7,
            status = 'pending', submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL, review_note = NULL
      WHERE user_id = $1 RETURNING id`,
    vals
  )
  if (!upd.rows[0]) {
    await pool.query(
      `INSERT INTO host_applications (user_id, full_name, national_id, phone, address, company, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      vals
    )
  }
  // File the identity documents and link them to the application, so approving
  // the application can approve the identity in the same decision. Re-reading
  // the status here rather than trusting the caller keeps the two writes
  // consistent even if a route ever forgets the check.
  const identity = await getVerificationStatusFromTable(userId)
  if (needsIdentityDocuments(identity.status) && f.id_front) {
    await submitVerificationImages({
      userId,
      front: f.id_front,
      back: f.id_back ?? null,
      idNumber: f.national_id,
      fullName: f.full_name,
      docType: f.doc_type ?? null,
      source: 'host_application',
    })
  }
  // Whether we just filed it or it was already on file, the application points at
  // the submission the reviewer should open.
  await pool.query(
    `UPDATE host_applications
        SET verification_id = (SELECT v.id FROM id_verifications v
                                WHERE v.user_id = $1 ORDER BY v.submitted_at DESC LIMIT 1)
      WHERE user_id = $1`,
    [userId]
  )
  // Persist the host type + company on the user (same as the web) so listings can
  // show a "Company"/"Brokerage" badge once the application is approved.
  await pool.query(`UPDATE users SET host_type = $2, company = $3 WHERE id = $1`, [userId, f.host_type, company])
  return getHostApplication(userId)
}

/** Admin queue — applications with the applicant's email. Defaults to 'pending'. */
export async function listHostApplications(status = 'pending'): Promise<HostApplication[]> {
  const filterable = status === 'pending' || status === 'approved' || status === 'rejected'
  const { rows } = await pool.query(
    `SELECT ${HOST_APP_COLS}, u.email
       FROM host_applications a JOIN users u ON u.id = a.user_id
      ${filterable ? 'WHERE a.status = $1' : ''}
      ORDER BY a.submitted_at ASC`,
    filterable ? [status] : []
  )
  return rows as HostApplication[]
}

// NOTE: this is the /ops version, adopted 21 Aug 2026. It keys on the APPLICATION
// id (not the user id) and records the deciding operator, which the audit log and
// the console both depend on. The previous signature took no actor.
/** Admin decision on a host application. Approve → set users.is_host + notify; reject → notify.
 *  The application row and the users flip are one transaction so an approval can never
 *  half-land (approved application, still not a host). The notification is sent after
 *  the commit — it must never roll a decision back. */
export async function reviewHostApplication(appId: string, action: 'approve' | 'reject', note: string | null, actor: string): Promise<void> {
  if (!isUuid(appId)) throw new Error('Invalid application')
  const status = action === 'approve' ? 'approved' : 'rejected'
  const client = await pool.connect()
  let uid = ''
  let verifiedIdentity = false
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      // `actor` is staff:<uuid>; this used to be the literal 'admin', which threw
      // away who actually made the call.
      `UPDATE host_applications SET status=$2, reviewed_at=now(), reviewed_by=$4, review_note=$3
        WHERE id=$1 RETURNING user_id`,
      [appId, status, note, actor]
    )
    uid = rows[0]?.user_id ?? ''
    if (!uid) throw new Error('Application not found')
    if (action === 'approve') {
      await client.query(`UPDATE users SET is_host = true WHERE id = $1`, [uid])
      // Keep the legacy `role` flag in sync so the mobile backend (which reads role)
      // also recognizes this host. The column is absent on a frontend-only dev DB, so
      // it runs behind a SAVEPOINT: a missing column must not abort the approval.
      try {
        await client.query('SAVEPOINT role_sync')
        await client.query(`UPDATE users SET role = 'host' WHERE id = $1`, [uid])
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT role_sync') /* role column not present */
      }
      // ONE decision approves both facts: the applicant becomes a host AND their
      // identity documents — submitted with the application and linked by
      // verification_id — are marked verified. Without this an approved host
      // would still be blocked by the listing gate with nothing left to do.
      const linked = await client.query(
        `SELECT verification_id FROM host_applications WHERE id = $1`,
        [appId],
      )
      const verifId = linked.rows[0]?.verification_id ?? null
      if (verifId) {
        await client.query(
          `UPDATE id_verifications
              SET status = 'verified', reviewed_at = now(), reviewed_by = $2, notes = $3
            WHERE id = $1`,
          [verifId, actor, note],
        )
        await client.query(
          `UPDATE users SET verification_status = 'verified', verified_at = now() WHERE id = $1`,
          [uid],
        )
        verifiedIdentity = true
      }
    } else {
      // Rejecting the application leaves the ID submission alone: it may be a
      // perfectly good document and the applicant may reapply. Rejecting the
      // identity is a separate decision in Verifications.
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  if (action === 'approve') {
    await createNotification(uid, {
      type: 'host',
      title: 'You are now a host!',
      body: verifiedIdentity
        ? 'Your host application and identity documents were approved — you can now list your space and accept guests.'
        : 'Your host application was approved. Verify your identity to start publishing listings.',
      link: verifiedIdentity ? '/host' : '/verify-id',
    })
  } else {
    await createNotification(uid, {
      type: 'host',
      title: 'Host application update',
      body: note ? `Your application needs attention: ${note}` : 'Your host application was not approved this time.',
      link: '/account',
    })
  }
}

// ---- The host listing gate ---------------------------------------------------

/**
 * The two facts that decide whether someone may put a listing in front of
 * guests: are they an approved host, and did an admin approve their ID?
 *
 * Host status is read from `is_host` OR `role='host'` because the two projects
 * write different columns — the web's application approval sets `is_host` (and
 * syncs `role` behind a SAVEPOINT that may not fire on a DB without the column),
 * while this backend has always keyed off `role`. Trusting only one would lock
 * out hosts approved through the other.
 */
export async function getListingGateState(
  userId: string
): Promise<{ isHost: boolean; verificationStatus: string }> {
  if (!isUuid(userId)) return { isHost: false, verificationStatus: 'unverified' }
  const { rows } = await pool.query(
    `SELECT (COALESCE(is_host, false) = true OR role = 'host') AS is_host,
            COALESCE(verification_status, 'unverified') AS verification_status
       FROM users WHERE id = $1`,
    [userId]
  )
  const r = rows[0]
  if (!r) return { isHost: false, verificationStatus: 'unverified' }
  return { isHost: Boolean(r.is_host), verificationStatus: String(r.verification_status) }
}

// ---- ID verification (id_verifications table — shared with web /ops admin) ---

export type VerificationTableStatus = 'unverified' | 'pending' | 'verified' | 'rejected'

export interface VerificationTableState {
  status: VerificationTableStatus
  verified_at: string | null
  /** Which document was filed, and the reviewer's note when one was left. The web's
   *  become-a-host form shows both — it used to read them from its own copy of this
   *  query, so leaving them out here would blank the screen rather than fail loudly. */
  doc_type: string | null
  notes: string | null
  /** The number on that submission, when it carried one. Sent to the signed-in
   *  user's own client so the become-a-host form can reuse an identity already
   *  on file instead of asking for the same number a second time — the rule is
   *  `nationalIdForApplication` in host-verification-core. */
  id_number: string | null
}

/** Submit FRONT (+ optional BACK) ID photos for review → upserts the user's
 *  PENDING row in id_verifications (the table the web /ops admin reads), so
 *  mobile-submitted IDs are visible to admins. Reuses an existing pending row.
 *  Stores FRONT→image_data, BACK→back_image_data, source='manual',
 *  status='pending'. */
export async function submitVerificationImages(args: {
  userId: string
  front: string
  back?: string | null
  idNumber?: string | null
  fullName?: string | null
  /** Which document this is. Required on new submissions (the reviewer checks
   *  the photo against the declared type); null only on rows predating it. */
  docType?: string | null
  /** Where the submission came from — 'manual' (the profile's verify card) or
   *  'host_application' (filed with a become-a-host application). /ops shows it,
   *  and it is the same vocabulary the web writes. */
  source?: 'manual' | 'host_application'
}): Promise<VerificationTableState> {
  const { userId, front, back = null, idNumber = null, fullName = null, docType = null, source = 'manual' } = args
  if (!isUuid(userId)) throw new Error('Invalid user')
  const f = String(front ?? '').trim()
  if (!/^data:image\//i.test(f) && !/^https?:\/\//i.test(f)) {
    throw new Error('Please attach a photo of the front of your ID')
  }
  if (f.length > 3_500_000) throw new Error('That front image is too large')
  const b = back == null ? null : String(back).trim() || null
  if (b && !/^data:image\//i.test(b) && !/^https?:\/\//i.test(b)) {
    throw new Error('Please attach a valid photo of the back of your ID')
  }
  if (b && b.length > 3_500_000) throw new Error('That back image is too large')

  const existing = await pool.query(
    `SELECT id FROM id_verifications WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
    [userId]
  )
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE id_verifications
          SET image_data = $2, back_image_data = $3,
              id_number = COALESCE($4, id_number),
              full_name = COALESCE($5, full_name),
              doc_type = COALESCE($6, doc_type),
              source = $7, status = 'pending',
              submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL, notes = NULL
        WHERE id = $1`,
      [existing.rows[0].id, f, b, idNumber, fullName, docType, source]
    )
  } else {
    await pool.query(
      `INSERT INTO id_verifications (user_id, image_data, back_image_data, id_number, full_name, doc_type, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [userId, f, b, idNumber, fullName, docType, source]
    )
  }
  // A resubmission must clear a previous rejection on the user row, or the gate
  // would keep reporting 'rejected' while a fresh submission sits in the queue.
  await pool.query(
    `UPDATE users SET verification_status = 'pending', verified_at = NULL
      WHERE id = $1 AND COALESCE(verification_status, 'unverified') <> 'verified'`,
    [userId]
  )
  // Read the row back rather than asserting `{ status: 'pending' }`: the upsert
  // COALESCEs the number, so what we just stored is not always what was sent
  // (a resubmission that omits it keeps the earlier one), and the clients now
  // prefill the host application from this value.
  return getVerificationStatusFromTable(userId)
}

/** The reviewer's note on the user's latest ID submission, or null.
 *  Only meaningful on a rejection, where it is the reason written for the host. */
export async function getVerificationNote(userId: string): Promise<string | null> {
  if (!isUuid(userId)) return null
  const { rows } = await pool.query(
    `SELECT notes FROM id_verifications WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
    [userId]
  )
  return (rows[0]?.notes as string | null) ?? null
}

/** The signed-in user's verification status, read from the latest
 *  id_verifications row. Defaults to 'unverified' when no row exists.
 *  verified_at is the review timestamp once status is 'verified'. */
export async function getVerificationStatusFromTable(userId: string): Promise<VerificationTableState> {
  if (!isUuid(userId)) return { status: 'unverified', verified_at: null, id_number: null, doc_type: null, notes: null }
  const { rows } = await pool.query(
    `SELECT status, id_number,
            CASE WHEN status = 'verified'
                 THEN to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END AS verified_at, doc_type, notes
       FROM id_verifications
      WHERE user_id = $1
      ORDER BY submitted_at DESC
      LIMIT 1`,
    [userId]
  )
  const r = rows[0]
  if (!r) return { status: 'unverified', verified_at: null, id_number: null, doc_type: null, notes: null }
  return {
    status: (r.status as VerificationTableStatus) ?? 'unverified',
    verified_at: r.verified_at ?? null,
    id_number: (r.id_number as string | null)?.trim() || null,
    doc_type: (r.doc_type as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  }
}

// ---- Chat: per-booking messages between guest and host ----------------------

export interface Message {
  id: string
  booking_id: string
  sender_id: string
  sender_name: string | null
  body: string
  created_at: string
}

/** All messages for a booking, oldest first, with the sender's display name. */
export async function getBookingMessages(bookingId: string): Promise<Message[]> {
  if (!isUuid(bookingId)) return []
  const { rows } = await pool.query(
    `SELECT m.id, m.booking_id, m.sender_id, u.full_name AS sender_name, m.body, m.created_at
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.booking_id = $1
      ORDER BY m.created_at ASC`,
    [bookingId]
  )
  return rows as Message[]
}

/** Post a message to a booking thread. Phone numbers, email addresses, social
 *  handles and off-platform links are blocked by any trick (see contentguard) —
 *  including splitting one across several messages. */
export async function createMessage(bookingId: string, senderId: string, body: string): Promise<Message> {
  if (!isUuid(bookingId) || !isUuid(senderId)) throw new Error('Invalid id')
  const text = String(body || '').trim().slice(0, 2000)
  if (!text) throw new Error('Message cannot be empty')

  // Block contact details — in this single message, or completed across the
  // sender's recent messages in this thread.
  await guardContent(senderId, text, 'chat', { type: 'booking', id: bookingId })
  const recent = await pool.query(
    `SELECT body FROM messages WHERE booking_id = $1 AND sender_id = $2 ORDER BY created_at DESC LIMIT 16`,
    [bookingId, senderId]
  )
  const priorBodies = recent.rows.map((r) => String(r.body || '')).reverse()
  await guardSplitContent(senderId, priorBodies, text, 'chat', { type: 'booking', id: bookingId })

  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO messages (booking_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *
     )
     SELECT ins.id, ins.booking_id, ins.sender_id, u.full_name AS sender_name, ins.body, ins.created_at
       FROM ins JOIN users u ON u.id = ins.sender_id`,
    [bookingId, senderId, text]
  )
  return rows[0] as Message
}

// ---- Place autocomplete (search-by-place typeahead) -------------------------

const CURATED_PLACES = [
  'Giza', 'North Coast', 'Sahel', 'El Gouna', 'Cairo', 'Zamalek', 'New Cairo',
  'Sheikh Zayed', '6th of October', 'Maadi', 'Hurghada', 'Sharm El Sheikh',
  'Alexandria', 'Marina', 'Ain Sokhna', 'Dahab', 'Luxor', 'Aswan',
]

/** Up to 8 place suggestions: distinct listing locations matching q, merged with
 *  a curated list of well-known Egyptian destinations. Empty q → curated list. */
export async function getPlaceSuggestions(q: string): Promise<string[]> {
  const query = (q || '').trim()
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    const k = p.trim().toLowerCase()
    if (!p.trim() || seen.has(k)) return
    seen.add(k); out.push(p.trim())
  }
  if (!query) {
    CURATED_PLACES.slice(0, 8).forEach(push)
    return out
  }
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT location FROM listings
        WHERE location IS NOT NULL AND location ILIKE '%' || $1 || '%'
        ORDER BY location LIMIT 8`,
      [query]
    )
    for (const r of rows) push(String(r.location))
  } catch { /* fall back to curated matches */ }
  CURATED_PLACES.filter((p) => p.toLowerCase().includes(query.toLowerCase())).forEach(push)
  return out.slice(0, 8)
}

// ---- Pre-booking chat (guest ⇄ host, before a booking exists) ---------------
// Uses the shared conversations + chat_messages tables (created by the web via
// xmig6). Distinct from the per-booking `messages` table above.

export interface ConversationSummary {
  id: string
  listing_id: string | null
  listing_title: string | null
  listing_image: string | null
  other_name: string | null
  last_message: string | null
  last_message_at: string
  is_host: boolean
}

export interface ChatThreadMessage {
  id: string
  sender_id: string
  body: string
  created_at: string
  mine?: boolean
}

/** Guest opens (or reuses) a thread with the listing's host. Returns the thread id. */
export async function getOrCreateConversation(
  guestId: string,
  listingId: string
): Promise<{ id: string; host_id: string; listing_title: string | null }> {
  if (!isUuid(guestId) || !isUuid(listingId)) throw new Error('Invalid id')
  const { rows: lr } = await pool.query(`SELECT host_id, title FROM listings WHERE id = $1`, [listingId])
  const listing = lr[0] as { host_id: string | null; title: string | null } | undefined
  if (!listing) throw new Error('Listing not found')
  if (!listing.host_id || !isUuid(listing.host_id)) throw new Error('This listing has no host to message yet')
  if (listing.host_id === guestId) throw new Error("You can't message your own listing")
  const { rows } = await pool.query(
    `INSERT INTO conversations (listing_id, guest_id, host_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (listing_id, guest_id) DO UPDATE SET listing_id = EXCLUDED.listing_id
     RETURNING id`,
    [listingId, guestId, listing.host_id]
  )
  return { id: rows[0].id as string, host_id: listing.host_id, listing_title: listing.title }
}

/** All threads a user is part of (as guest or host), newest activity first. */
export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT c.id, c.listing_id,
            l.title AS listing_title,
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS listing_image,
            CASE WHEN c.guest_id = $1 THEN hu.full_name ELSE gu.full_name END AS other_name,
            (SELECT m.body FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            to_char(c.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_message_at,
            (c.host_id = $1) AS is_host
       FROM conversations c
       LEFT JOIN listings l ON l.id = c.listing_id
       LEFT JOIN users gu ON gu.id = c.guest_id
       LEFT JOIN users hu ON hu.id = c.host_id
      WHERE c.guest_id = $1 OR c.host_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT 200`,
    [userId]
  )
  return rows as ConversationSummary[]
}

async function conversationForUser(userId: string, conversationId: string) {
  const { rows } = await pool.query(
    `SELECT id, listing_id, guest_id, host_id FROM conversations
      WHERE id = $1 AND (guest_id = $2 OR host_id = $2)`,
    [conversationId, userId]
  )
  return rows[0] as { id: string; listing_id: string | null; guest_id: string; host_id: string } | undefined
}

/** Messages in a thread, oldest first. Only members can read. */
export async function listChatMessages(userId: string, conversationId: string): Promise<ChatThreadMessage[]> {
  if (!isUuid(userId) || !isUuid(conversationId)) throw new Error('Invalid id')
  const convo = await conversationForUser(userId, conversationId)
  if (!convo) throw new Error('Conversation not found')
  const { rows } = await pool.query(
    `SELECT id, sender_id, body, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM chat_messages WHERE conversation_id = $1 ORDER BY chat_messages.created_at ASC LIMIT 500`,
    [conversationId]
  )
  return (rows as ChatThreadMessage[]).map((m) => ({ ...m, mine: m.sender_id === userId }))
}

/** Post a message. Contact details are blocked (contentguard), including ones
 *  split across the sender's recent messages. Notifies the other party. */
export async function postChatMessage(userId: string, conversationId: string, rawBody: string): Promise<ChatThreadMessage> {
  if (!isUuid(userId) || !isUuid(conversationId)) throw new Error('Invalid id')
  const body = String(rawBody || '').trim().slice(0, 2000)
  if (!body) throw new Error('Message is empty')
  await guardContent(userId, body, 'chat', { type: 'conversation', id: conversationId })
  const convo = await conversationForUser(userId, conversationId)
  if (!convo) throw new Error('Conversation not found')
  // Pre-booking is where a host is most tempted to hand over a number, so the
  // same drip-feed check the booking thread runs applies here too.
  const recent = await pool.query(
    `SELECT body FROM chat_messages WHERE conversation_id = $1 AND sender_id = $2 ORDER BY created_at DESC LIMIT 16`,
    [conversationId, userId]
  )
  await guardSplitContent(userId, recent.rows.map((r) => String(r.body || '')).reverse(), body, 'chat', { type: 'conversation', id: conversationId })
  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO chat_messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *
     ), upd AS ( UPDATE conversations SET last_message_at = now() WHERE id = $1 )
     SELECT id, sender_id, body, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at FROM ins`,
    [conversationId, userId, body]
  )
  const other = convo.guest_id === userId ? convo.host_id : convo.guest_id
  await createNotification(other, { type: 'message', title: 'New message', body: body.slice(0, 80), link: '/messages' })
  const msg = rows[0] as ChatThreadMessage
  return { ...msg, mine: true }
}

/**
 * Record a user sign-in (F1) — the ONE activity event that can't be derived, because
 * nothing else in the schema records that a user logged in: no last_login_at, and no
 * user session table (auth is a stateless 30-day JWT). The web project's /ops activity
 * feed reads this table; both projects write it, since the mobile apps sign in here.
 *
 * Best-effort by design: a logging failure must never stop someone signing in.
 */
export async function recordLogin(
  userId: string,
  method: 'password' | 'otp' | 'google' | 'social',
  req?: Request,
): Promise<void> {
  try {
    if (!isUuid(userId)) return
    const ip = req
      ? (req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || null)
      : null
    const ua = req ? (req.headers.get('user-agent') || '').slice(0, 300) || null : null
    await pool.query(
      `INSERT INTO user_logins (user_id, method, ip, user_agent) VALUES ($1, $2, $3, $4)`,
      [userId, method, ip, ua],
    )
  } catch {
    /* never block a sign-in over telemetry */
  }
}

// ---- Host payout method (host_payout_methods) --------------------------------

/**
 * Where a host wants their earnings sent. One row per host, so this reads at
 * most one; `null` means they have not completed that part of their profile.
 *
 * Returns the view shape (labels + the masked `display` line) rather than the
 * raw row, so web, iOS and Android all render the same wording.
 */
export async function getPayoutMethod(userId: string): Promise<PayoutMethodView | null> {
  if (!isUuid(userId)) return null
  try {
    const { rows } = await pool.query(
      `SELECT method, account_name, account_ref, bank_name, iban, account_number,
              swift_bic, branch, provider, updated_at
         FROM host_payout_methods WHERE user_id = $1`,
      [userId]
    )
    return rowToPayoutMethod(rows[0] ?? null)
  } catch (e) {
    // The table is absent until migrate-payout-methods.mjs runs. Read as "none
    // set" rather than 500ing the whole profile over a feature the host has not
    // used yet.
    console.error('getPayoutMethod fell back to null:', e)
    return null
  }
}

/**
 * Save the host's chosen destination, replacing whatever was there.
 *
 * `record` must come from validatePayout — that is what guarantees the fields of
 * the other two methods are cleared rather than carried over. Upsert on user_id:
 * a host has one payout method, and switching from a bank account to a wallet
 * rewrites the row rather than adding one.
 */
export async function savePayoutMethod(
  userId: string,
  record: PayoutMethodRecord
): Promise<PayoutMethodView | null> {
  if (!isUuid(userId)) throw new Error('Invalid user')
  const { rows } = await pool.query(
    `INSERT INTO host_payout_methods
       (user_id, method, account_name, account_ref, bank_name, iban, account_number, swift_bic, branch, provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id) DO UPDATE
        SET method         = EXCLUDED.method,
            account_name   = EXCLUDED.account_name,
            account_ref    = EXCLUDED.account_ref,
            bank_name      = EXCLUDED.bank_name,
            iban           = EXCLUDED.iban,
            account_number = EXCLUDED.account_number,
            swift_bic      = EXCLUDED.swift_bic,
            branch         = EXCLUDED.branch,
            provider       = EXCLUDED.provider,
            updated_at     = now()
     RETURNING method, account_name, account_ref, bank_name, iban, account_number,
               swift_bic, branch, provider, updated_at`,
    [userId, record.method, record.account_name, record.account_ref, record.bank_name,
     record.iban, record.account_number, record.swift_bic, record.branch, record.provider]
  )
  return rowToPayoutMethod(rows[0] ?? null)
}

/** Remove the host's payout method. Idempotent — returns false if none existed. */
export async function deletePayoutMethod(userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false
  const { rowCount } = await pool.query(`DELETE FROM host_payout_methods WHERE user_id = $1`, [userId])
  return (rowCount ?? 0) > 0
}

// ============================================================================
// /ops — the staff console
//
// Ported from quickin-frontend on 21 Aug 2026, consolidating both projects'
// API onto this one. The web keeps the /ops PAGES and reaches these through
// the API instead of its own database client. See README -> /ops.
// ============================================================================

/** Admin: manually mark a user's email as verified (when OTP email can't reach them). */
export async function adminActivateUser(id: string): Promise<void> {
  if (!isUuid(id)) throw new Error('Invalid user')
  await pool.query(`UPDATE users SET email_verified = true WHERE id = $1`, [id])
  await createNotification(id, { type: 'account', title: 'Account activated', body: 'Your email was verified by our team — you can use your account normally now.', link: '/account' })
}

/** Delete a listing (FK cascades remove its images / bookings / reviews). */
export async function adminDeleteListing(id: string): Promise<void> {
  if (!isUuid(id)) throw new Error('Invalid listing')
  await pool.query(`DELETE FROM listings WHERE id = $1`, [id])
}

/** Self-service account deletion ONLY — the App Store 5.1.1(v) / Google Play route
 *  at /api/local/account. **Not** an admin action: /ops blocks and removes instead
 *  (adminSetAccountStatus), which is reversible and keeps booking and payment
 *  history for disputes. Most child rows cascade, but listings.host_id has no
 *  ON DELETE CASCADE, so their listings are removed first (which cascades to those
 *  listings' images / bookings / reviews). Transactional. */
export async function adminDeleteUser(id: string): Promise<void> {
  if (!isUuid(id)) throw new Error('Invalid user')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM listings WHERE host_id = $1`, [id])
    await client.query(`DELETE FROM users WHERE id = $1`, [id])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/** D2 — everything the /ops user profile renders, in one round of queries.
 *  Returns null for an unknown or non-uuid id so the route can 404. */
export async function adminGetUserDetail(id: string): Promise<AdminUserDetail | null> {
  if (!isUuid(id)) return null
  const { rows: urows } = await pool.query(
    `SELECT ${ADMIN_USER_COLS},
            u.phone, u.country, u.bio, u.avatar_url, u.role, u.host_type, u.company, u.referral_code
       FROM users u WHERE u.id = $1`,
    [id],
  )
  const user = urows[0] as AdminUserDetail['user'] | undefined
  if (!user) return null

  const [listings, bookings, payments, conversations, verifications, applications, stats] = await Promise.all([
    pool.query(
      `SELECT l.id, l.title, COALESCE(l.is_published, false) AS is_published,
              COALESCE(l.approval_status, 'approved') AS approval_status,
              COALESCE(l.unpublished_by_admin, false) AS unpublished_by_admin,
              COALESCE(l.price_per_night, 0)::float8 AS price_per_night,
              COALESCE(l.currency, 'USD') AS currency,
              to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
              (SELECT COUNT(*) FROM bookings b WHERE b.listing_id = l.id)::int AS booking_count
         FROM listings l WHERE l.host_id = $1 ORDER BY l.created_at DESC LIMIT 200`,
      [id],
    ),
    pool.query(
      `SELECT b.id, b.reservation_code, b.listing_id, l.title AS listing_title,
              b.status, COALESCE(b.payment_status, 'unpaid') AS payment_status,
              COALESCE(b.total_price, 0)::float8 AS total_price,
              COALESCE(l.currency, 'USD') AS currency,
              to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
              to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
              to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM bookings b LEFT JOIN listings l ON l.id = b.listing_id
        WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 200`,
      [id],
    ),
    // Payment proofs have no direct user FK — they hang off the booking.
    pool.query(
      `SELECT pp.id, pp.booking_id, b.reservation_code, l.title AS listing_title,
              COALESCE(pp.amount, b.total_price, 0)::float8 AS amount,
              pp.status, pp.reject_reason,
              to_char(pp.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
              to_char(pp.reviewed_at AT TIME ZONE 'UTC',  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at
         FROM payment_proofs pp
         JOIN bookings b ON b.id = pp.booking_id
         LEFT JOIN listings l ON l.id = b.listing_id
        WHERE b.user_id = $1 ORDER BY pp.submitted_at DESC LIMIT 200`,
      [id],
    ),
    adminListUserConversations(id),
    pool.query(
      `SELECT id, status, notes,
              to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
              to_char(reviewed_at AT TIME ZONE 'UTC',  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
              (image_data IS NOT NULL) AS has_document
         FROM id_verifications WHERE user_id = $1 ORDER BY id_verifications.submitted_at DESC LIMIT 20`,
      [id],
    ),
    pool.query(
      `SELECT id, status, COALESCE(review_note, notes) AS notes,
              to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
              to_char(reviewed_at AT TIME ZONE 'UTC',  'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
              (national_id IS NOT NULL) AS has_document
         FROM host_applications WHERE user_id = $1 ORDER BY host_applications.submitted_at DESC LIMIT 20`,
      [id],
    ),
    pool.query(
      `SELECT COALESCE((SELECT SUM(b.total_price) FROM bookings b
                         WHERE b.user_id = $1 AND COALESCE(b.payment_status,'unpaid') = 'paid'), 0)::float8 AS gross_paid,
              COALESCE((SELECT SUM(b.check_out - b.check_in) FROM bookings b
                         WHERE b.user_id = $1 AND b.status <> 'cancelled'), 0)::int AS nights_booked,
              (SELECT COUNT(*) FROM messages m WHERE m.sender_id = $1)::int AS mobile_message_count,
              (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'user' AND r.target_id = $1)::int AS report_count`,
      [id],
    ),
  ])

  const documents: AdminUserDocument[] = [
    ...verifications.rows.map((r) => ({ ...(r as Omit<AdminUserDocument, 'kind'>), kind: 'id_verification' as const })),
    ...applications.rows.map((r) => ({ ...(r as Omit<AdminUserDocument, 'kind'>), kind: 'host_application' as const })),
  ]

  return {
    user,
    listings: listings.rows as AdminUserListing[],
    bookings: bookings.rows as AdminUserBooking[],
    payments: payments.rows as AdminUserPayment[],
    conversations,
    documents,
    stats: stats.rows[0] as AdminUserDetail['stats'],
  }
}

/** Newest-first bookings (LIMIT 300) with guest + listing details. */
export async function adminListBookings(): Promise<AdminBookingRow[]> {
  const { rows } = await pool.query(
    `SELECT b.id,
            NULLIF(b.reservation_code, '') AS reservation_code,
            b.status,
            CASE WHEN b.paid_at IS NULL THEN 'unpaid' ELSE 'paid' END AS payment_status,
            -- What the guest owes; host_payout is the host's raw share of it, and
            -- commission is the gap between them — the platform's margin on this
            -- one booking, priced at the rate it was taken at.
            ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)}::float8 AS total_price,
            b.total_price::float8 AS host_payout,
            ${COMMISSION_AMOUNT_SQL}::float8 AS commission,
            ${BOOKING_RATE_SQL}::float8 AS commission_rate,
            COALESCE(l.currency, 'USD') AS currency,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            gu.full_name AS guest_name, gu.email AS guest_email,
            l.title AS listing_title,
            to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM bookings b
       LEFT JOIN listings l ON l.id = b.listing_id
       LEFT JOIN users gu ON gu.id = b.user_id
      ORDER BY b.created_at DESC
      LIMIT 300`
  )
  return rows as AdminBookingRow[]
}

/** Newest-first listings (LIMIT 300) with host name, booking count and a primary image. */
export async function adminListListings(): Promise<AdminListingRow[]> {
  const { rows } = await pool.query(
    `SELECT l.id, l.title, l.location, COALESCE(l.currency, 'USD') AS currency,
            -- Staff see both: the price guests are quoted, and the host's own.
            ${sqlWithCommission('l.price_per_night')}::float8 AS price_per_night,
            l.price_per_night::float8 AS host_price_per_night,
            l.is_published,
            COALESCE(l.approval_status, 'approved') AS approval_status,
            (l.ownership_doc IS NOT NULL AND l.ownership_doc <> '') AS has_ownership_doc,
            l.host_id, u.full_name AS host_name, l.region,
            -- Location fields the console cross-checks against the map pin.
            l.country, l.lat::float8 AS lat, l.lng::float8 AS lng,
            -- The approval flow needs to know whether the resort is a catalog entry
            -- or free text the host typed via "Other" (which needs review).
            l.resort_id, l.resort_name,
            COALESCE(r.name, l.resort_name) AS resort,
            to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            (SELECT COUNT(*) FROM bookings b WHERE b.listing_id = l.id)::int AS booking_count,
            (SELECT li.url FROM listing_images li WHERE li.listing_id = l.id
              ORDER BY li."order" LIMIT 1) AS image
       FROM listings l
       LEFT JOIN users u ON u.id = l.host_id
       LEFT JOIN resorts r ON r.id = l.resort_id
      ORDER BY l.created_at DESC
      LIMIT 300`
  )
  return rows as AdminListingRow[]
}

/** Pending bookings awaiting host (or admin) approval. Newest-first. */
export async function adminListPendingBookings(): Promise<AdminPendingBookingRow[]> {
  const { rows } = await pool.query(
    `SELECT b.id,
            NULLIF(b.reservation_code, '') AS reservation_code,
            b.status,
            CASE WHEN b.paid_at IS NULL THEN 'unpaid' ELSE 'paid' END AS payment_status,
            b.total_price::float8 AS total_price,
            COALESCE(l.currency, 'USD') AS currency,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.guests,
            gu.full_name AS guest_name, gu.email AS guest_email,
            l.title AS listing_title, l.location AS listing_location,
            hu.full_name AS host_name, hu.email AS host_email, l.host_id,
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS image,
            to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM bookings b
       LEFT JOIN listings l ON l.id = b.listing_id
       LEFT JOIN users gu ON gu.id = b.user_id
       LEFT JOIN users hu ON hu.id = l.host_id
      WHERE b.status = 'pending'
      ORDER BY b.created_at DESC
      LIMIT 200`
  )
  return rows as AdminPendingBookingRow[]
}

/**
 * Transfer screenshots waiting for a decision.
 *
 * This queue did not exist. `adminListDisputes` is hard-filtered to
 * `pp.status = 'disputed'`, and the only path that could approve a FRESH proof —
 * hostReviewPayment — was guarded by `b.status = 'pending'`, while a guest can only
 * pay once the booking is 'confirmed'. So a screenshot submitted through the normal
 * flow had no reviewer at all and sat in 'submitted' indefinitely.
 *
 * Latest proof per booking only, so a superseded submission doesn't queue twice.
 */
export async function adminListPendingProofs(): Promise<PendingProofRow[]> {
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, b.reservation_code, l.title,
            b.user_id AS guest_id,
            (SELECT full_name FROM users u WHERE u.id = b.user_id) AS guest_name,
            (SELECT email     FROM users u WHERE u.id = b.user_id) AS guest_email,
            l.host_id,
            -- Commission-inclusive on BOTH: the reviewer compares these against
            -- the sum on a guest's Instapay screenshot, and the guest transferred
            -- the marked-up total. Showing the raw price here would make every
            -- correct payment look like an overpayment.
            ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)}::float8 AS total_price,
            COALESCE(pp.amount, ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)})::float8 AS amount,
            pp.method,
            to_char(pp.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(b.check_out, 'YYYY-MM-DD') AS check_out
       FROM payment_proofs pp
       JOIN bookings b ON b.id = pp.booking_id
       JOIN listings l ON l.id = b.listing_id
      WHERE pp.status = 'submitted'
        AND pp.id = (SELECT id FROM payment_proofs p2 WHERE p2.booking_id = pp.booking_id ORDER BY p2.submitted_at DESC LIMIT 1)
      ORDER BY pp.submitted_at ASC`
  )
  return rows as PendingProofRow[]
}

/**
 * The abuse-report queue (F4).
 *
 * Ported from the backend's trust.ts, which has had this logic — and a full triage API
 * — since the trust work landed. /ops lives in this project and had neither, so the
 * `reports` staff module gated a route the console could never reach and no filed
 * report had ever been seen by anyone.
 *
 * The target is resolved to a label here rather than in the UI so a moderator can tell
 * what they're looking at without opening three tabs.
 */
export async function adminListReports(status = 'open'): Promise<AdminReport[]> {
  const filterable = status === 'open' || status === 'resolved' || status === 'dismissed'
  const { rows } = await pool.query(
    `SELECT r.id, r.reporter_id, u.full_name AS reporter_name, u.email AS reporter_email,
            r.target_type, r.target_id, r.reason, r.details, r.status,
            to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(r.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS resolved_at,
            CASE r.target_type
              WHEN 'user'    THEN (SELECT COALESCE(NULLIF(tu.full_name, ''), tu.email) FROM users tu WHERE tu.id = r.target_id)
              WHEN 'listing' THEN (SELECT tl.title FROM listings tl WHERE tl.id = r.target_id)
              WHEN 'review'  THEN (SELECT left(COALESCE(tr.comment, ''), 80) FROM reviews tr WHERE tr.id = r.target_id)
            END AS target_label
       FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
      ${filterable ? 'WHERE r.status = $1' : ''}
      ORDER BY r.created_at DESC
      LIMIT 300`,
    filterable ? [status] : [],
  )
  return rows as AdminReport[]
}

/** Read a thread's message bodies for /ops. Returns null unless the conversation is
 *  one THIS user belongs to — so an operator can't page through arbitrary threads by
 *  guessing ids; they have to come in via a profile. The route logs every call. */
export async function adminReadConversation(
  userId: string,
  conversationId: string,
): Promise<{ conversation: AdminUserConversation; messages: AdminThreadMessage[] } | null> {
  if (!isUuid(userId) || !isUuid(conversationId)) return null
  const conversation = (await adminListUserConversations(userId)).find((c) => c.id === conversationId)
  if (!conversation) return null
  const { rows } = await pool.query(
    `SELECT m.id, m.sender_id, u.full_name AS sender_name, m.body,
            to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1 ORDER BY m.created_at ASC LIMIT 500`,
    [conversationId],
  )
  return { conversation, messages: rows as AdminThreadMessage[] }
}

/**
 * One document's stored value, looked up THROUGH its subject.
 *
 * Returns null for a missing row, a missing column value, and a non-uuid id alike —
 * the route collapses all three to an identical 404 so an operator can't tell "no
 * such user" from "that user has no selfie on file".
 *
 * `column` comes from `idColumnFor`, a closed map that is unit-tested to contain only
 * bare identifiers — nothing user-supplied is ever interpolated here.
 */
export async function adminReadDocument(
  kind: DocumentKind,
  id: string,
): Promise<{ value: string; subjectId: string } | null> {
  if (!isUuid(id)) return null
  if (kind === 'ownership') {
    const { rows } = await pool.query(
      `SELECT ownership_doc AS value, host_id AS subject_id FROM listings WHERE id = $1`,
      [id],
    )
    const row = rows[0] as { value: string | null; subject_id: string | null } | undefined
    if (!row?.value) return null
    // The listing is the subject for audit purposes, so its own id is the target.
    return { value: row.value, subjectId: id }
  }
  const changeColumn = idChangeColumnFor(kind)
  if (changeColumn) {
    const { rows } = await pool.query(
      `SELECT ${changeColumn} AS value, user_id AS subject_id FROM id_change_requests WHERE id = $1`,
      [id],
    )
    const row = rows[0] as { value: string | null; subject_id: string } | undefined
    if (!row?.value) return null
    // The user is the subject, same as a verification — so "everything ever opened
    // about this person" stays one lookup whichever queue the document came from.
    return { value: row.value, subjectId: row.subject_id }
  }
  const column = idColumnFor(kind)
  if (!column) return null
  const { rows } = await pool.query(
    `SELECT ${column} AS value, user_id AS subject_id FROM id_verifications WHERE id = $1`,
    [id],
  )
  const row = rows[0] as { value: string | null; subject_id: string } | undefined
  if (!row?.value) return null
  return { value: row.value, subjectId: row.subject_id }
}

/**
 * Take a profile photo down (/ops → user → Remove photo).
 *
 * A photo goes live the moment it is picked, on the web and in both apps — there
 * is no review queue in front of it, and there shouldn't be: nobody would wait an
 * hour to have a face on their profile. What a photo needs instead is a way DOWN,
 * because it is the one field on a profile that no filter can read. `contentguard`
 * catches a phone number typed into a name or a bio; a phone number written on a
 * piece of paper and photographed is invisible to it, and so is everything else a
 * photo can be. So the answer to a reported photo is a moderator with one button,
 * and this is that button.
 *
 * Returns null for an unknown id — the route 404s on it — and `removed: false`
 * when the account exists but had no photo, so the console can say so rather than
 * claim to have taken down nothing.
 */
export async function adminRemoveUserAvatar(
  userId: string,
): Promise<{ removed: boolean; email: string } | null> {
  if (!isUuid(userId)) return null
  // The self-join reads the row as it was BEFORE this statement, which is how one
  // query can both clear the photo and report whether there was one to clear — a
  // read followed by a write would race a second moderator clicking the same
  // button, and report "removed" twice for one photo.
  const { rows } = await pool.query(
    `UPDATE users u SET avatar_url = NULL
       FROM users prev
      WHERE u.id = $1 AND prev.id = u.id
      RETURNING u.email, (prev.avatar_url IS NOT NULL) AS had_photo`,
    [userId],
  )
  const row = rows[0] as { email: string; had_photo: boolean } | undefined
  if (!row) return null
  return { removed: !!row.had_photo, email: row.email }
}

/** Resolve or dismiss a report. Returns false when the id doesn't exist. */
export async function adminResolveReport(
  reportId: string,
  status: 'resolved' | 'dismissed',
): Promise<boolean> {
  if (!isUuid(reportId)) return false
  const { rowCount } = await pool.query(
    `UPDATE reports SET status = $2, resolved_at = now() WHERE id = $1`,
    [reportId, status],
  )
  return (rowCount ?? 0) > 0
}

/**
 * An admin accepts or rejects a transfer screenshot.
 *
 * Note what rejecting does NOT do: it leaves `bookings.status` alone. The old host
 * review flipped the whole booking to 'rejected' on a bad screenshot, cancelling a
 * real reservation over an unreadable photo. Here the booking stays confirmed and the
 * guest can upload a clearer one — `canPay` treats a rejected payment as payable.
 *
 * Transactional so the proof row and the booking can never disagree about the outcome.
 */
export async function adminReviewProof(
  bookingId: string,
  action: PaymentReviewAction,
  reason: string | null,
  actor: string,
): Promise<{ guestId: string; title: string | null } | null> {
  if (!isUuid(bookingId)) throw new Error('Invalid booking')
  const out = outcomeFor(action)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT b.user_id, l.title FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`,
      [bookingId],
    )
    const row = rows[0] as { user_id: string; title: string | null } | undefined
    if (!row) { await client.query('ROLLBACK'); return null }

    await client.query(
      `UPDATE bookings SET payment_status = $2,
              paid_at = CASE WHEN $3 THEN COALESCE(paid_at, now()) ELSE paid_at END
        WHERE id = $1`,
      [bookingId, out.paymentState, out.markPaid],
    )
    // Only the latest proof — an older superseded one keeps its own history.
    await client.query(
      `UPDATE payment_proofs SET status = $2, reviewed_by = $3, reviewed_at = now(),
              reject_reason = $4
        WHERE id = (SELECT id FROM payment_proofs WHERE booking_id = $1 ORDER BY submitted_at DESC LIMIT 1)`,
      [bookingId, out.proofStatus, actor, reason],
    )
    await client.query('COMMIT')

    await createNotification(row.user_id, {
      type: 'payment',
      title: action === 'accept' ? 'Payment confirmed' : 'We could not confirm your transfer',
      body: action === 'accept'
        ? `Your booking for ${row.title ?? 'your stay'} is fully confirmed.`
        : (reason
            ? `${row.title ?? 'Your stay'} — ${reason}. You can upload another screenshot.`
            : `${row.title ?? 'Your stay'} — please upload a clearer screenshot of the transfer.`),
      link: '/reservations',
    })
    return { guestId: row.user_id, title: row.title }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/** D1 — the /ops users directory: search, filter, sort and page through every
 *  account with their verification status, listing and booking counts.
 *
 *  `total` is the post-filter count, taken from the same query via COUNT(*) OVER ()
 *  so pagination needs no second round trip. Replaces the old unfiltered
 *  `adminListUsers()`, whose hardcoded LIMIT 300 silently hid older accounts. */
export async function adminSearchUsers(
  filter: UserListFilter,
): Promise<{ users: AdminUserRow[]; total: number }> {
  const { where, params } = buildUserListWhere(filter)
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  // ORDER BY comes from a whitelist (orderBySql), never from raw input.
  const { rows } = await pool.query(
    `SELECT ${ADMIN_USER_COLS}, COUNT(*) OVER ()::int AS total_count
       FROM users u
       ${whereSql}
      ORDER BY ${orderBySql(filter.sort)}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filter.limit, filter.offset],
  )
  // total_count rides on every row; strip it so callers get a clean AdminUserRow.
  const users = rows.map(({ total_count: _total, ...rest }) => rest) as AdminUserRow[]
  let total = rows.length ? Number((rows[0] as { total_count: number }).total_count) : 0
  // An empty page past the end carries no row to read the window count from, so
  // "0 of 0" would be reported for a non-empty table. Only then pay for a COUNT.
  if (!rows.length && filter.offset > 0) {
    const { rows: c } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u ${whereSql}`,
      params,
    )
    total = Number((c[0] as { total: number })?.total ?? 0)
  }
  return { users, total }
}

/**
 * The one writer of `users.account_status`, for all four transitions.
 *
 * Blocking or removing hides the account's published listings and flags them
 * `unpublished_by_admin`; returning to active republishes EXACTLY those, so a
 * listing the host had taken down themselves stays down. Transactional, with the
 * user row locked, so status and listing visibility can never disagree.
 *
 * Refuses to touch a `role='admin'` row: staff.ts's legacy-admin fallback resolves
 * such a user through getUserFromRequest, so blocking one would lock the legacy
 * operator out of /ops entirely.
 *
 * History lives in staff_audit_log (written by the route); the status_changed_*
 * columns hold just the latest transition for cheap display.
 */
export async function adminSetAccountStatus(
  id: string,
  next: AccountStatus,
  opts: { reason?: string | null; actor: string },
): Promise<{ previous: AccountStatus; email: string; listingsChanged: number }> {
  if (!isUuid(id)) throw new Error('Invalid user')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT email, role, COALESCE(account_status, 'active') AS account_status
         FROM users WHERE id = $1 FOR UPDATE`,
      [id],
    )
    const row = rows[0] as { email: string; role: string | null; account_status: string } | undefined
    if (!row) throw new Error('User not found')
    if (String(row.role ?? '').toLowerCase() === 'admin') {
      throw new Error('Cannot change the status of an admin account')
    }
    const previous = normalizeStatus(row.account_status)

    await client.query(
      `UPDATE users
          SET account_status = $2, status_reason = $3,
              status_changed_at = now(), status_changed_by = $4
        WHERE id = $1`,
      [id, next, opts.reason ?? null, opts.actor],
    )

    let listingsChanged = 0
    if (hidesListings(next) && !hidesListings(previous)) {
      // Only currently-published listings are touched, so pending/rejected ones are
      // never flagged and can't be published by a later restore.
      const hid = await client.query(
        `UPDATE listings SET is_published = false, unpublished_by_admin = true
          WHERE host_id = $1 AND is_published = true`,
        [id],
      )
      listingsChanged = hid.rowCount ?? 0
    } else if (!hidesListings(next) && hidesListings(previous)) {
      const shown = await client.query(
        // Not the ones verification took down — those come back only when the
        // host is verified again.
        `UPDATE listings SET is_published = true, unpublished_by_admin = false
          WHERE host_id = $1 AND unpublished_by_admin = true
            AND COALESCE(unpublished_by_verification, false) = false
            AND COALESCE(approval_status, 'approved') = 'approved'`,
        [id],
      )
      listingsChanged = shown.rowCount ?? 0
      // A listing rejected while the account was down stays hidden, but must not
      // stay flagged — otherwise a future restore would resurrect it.
      await client.query(
        `UPDATE listings SET unpublished_by_admin = false
          WHERE host_id = $1 AND unpublished_by_admin = true`,
        [id],
      )
    }

    await client.query('COMMIT')
    return { previous, email: row.email, listingsChanged }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/** Admin drives a reservation's lifecycle (pending → confirmed → completed, or
 *  rejected/cancelled). Issues the reservation code on confirm/complete. */
export async function adminSetBookingStatus(
  bookingId: string,
  status: string,
): Promise<{ updated: boolean; status: string }> {
  if (!/^[0-9a-fA-F-]{36}$/.test(bookingId)) throw new Error('Invalid id')
  if (!(BOOKING_STATUSES as readonly string[]).includes(status)) throw new Error('Invalid status')
  const { rows } = await pool.query(
    `UPDATE bookings b SET status = $2,
            reservation_code = CASE WHEN $2 IN ('confirmed', 'completed')
                                    THEN COALESCE(b.reservation_code, $3)
                                    ELSE b.reservation_code END
       FROM listings l
      WHERE b.id = $1 AND l.id = b.listing_id
      RETURNING b.user_id, l.title`,
    [bookingId, status, genReservationCode()]
  )
  const row = rows[0]
  if (row) {
    const completed = status === 'completed'
    await createNotification(row.user_id, {
      type: 'booking',
      title: completed ? 'Your stay is complete' : `Reservation ${status}`,
      body: completed
        ? `How was ${row.title}? Tap to leave a review.`
        : `Your reservation for ${row.title} is now ${status}.`,
      link: `/reservation/${bookingId}`,
    })
  }
  return { updated: rows.length > 0, status }
}

/** Admin: directly set (or clear) a user's host role. Unified account — a host is
 *  also a guest, so this only flips `is_host` (and keeps the legacy `role` in sync
 *  for the mobile backend). Notifies the user when they gain hosting. Note: the
 *  mobile apps cache is_host at login and only re-read it on a fresh sign-in, so a
 *  user promoted here sees host surfaces after signing out and back in. */
export async function adminSetHost(id: string, makeHost: boolean): Promise<void> {
  if (!isUuid(id)) throw new Error('Invalid user')
  await pool.query(`UPDATE users SET is_host = $2 WHERE id = $1`, [id, makeHost])
  // Legacy role column: absent on some dev DBs, so best-effort.
  try { await pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [id, makeHost ? 'host' : 'guest']) } catch { /* role column not present */ }
  if (makeHost) {
    await createNotification(id, { type: 'host', title: 'You are now a host!', body: 'Your account was upgraded to host — sign out and back in to start listing your space.', link: '/host' })
  }
}

/**
 * Admin moderation decision on a pending listing. Approving flips approval_status
 * to 'approved' AND publishes it (so it appears in search); rejecting sets
 * 'rejected' and keeps it unpublished. Either way the host gets a notification —
 * which surfaces on both web and mobile (shared notifications table). Mirrors
 * reviewHostApplication.
 */
export async function adminSetListingApproval(
  id: string,
  action: 'approve' | 'reject',
  note?: string | null,
): Promise<void> {
  if (!isUuid(id)) throw new Error('Invalid listing')
  // Going live is the moment that matters: a listing can outlive the verification
  // that allowed it to be created, so publishing re-checks the host rather than
  // trusting the create-time gate. The backend project's setListingApproval has
  // always done this; /ops — where approvals actually happen — did not, which
  // meant the one path an operator uses could publish an unverified host.
  if (action === 'approve') {
    const { rows: hostRows } = await pool.query(
      `SELECT COALESCE(u.verification_status, 'unverified') AS status
         FROM listings l JOIN users u ON u.id = l.host_id
        WHERE l.id = $1`,
      [id],
    )
    const hostStatus = hostRows[0]?.status as string | undefined
    if (hostStatus && hostStatus !== 'verified') {
      throw new ListingInputError(
        `This host is not identity-verified (${hostStatus}). Approve their ID in Verifications first — ` +
        `a listing must not go live before its host is verified.`,
      )
    }
  }
  const status = action === 'approve' ? 'approved' : 'rejected'
  // The note is stored, not just announced. It used to exist only inside the
  // notification body below, so a host who missed that one notification saw a
  // "Rejected" badge and had no way to learn what to fix — /host and the listing
  // editor now read `review_note` back. Approving clears it: the note describes a
  // rejection, and a stale one under a live listing reads as a fresh complaint.
  const reviewNote = action === 'reject' ? normalizeListingReviewNote(note) : null
  const { rows } = await pool.query(
    `UPDATE listings SET approval_status = $2, is_published = $3, review_note = $4 WHERE id = $1
     RETURNING host_id, title`,
    [id, status, action === 'approve', reviewNote],
  )
  const row = rows[0] as { host_id: string | null; title: string | null } | undefined
  if (!row) throw new Error('Listing not found')
  if (!row.host_id) return
  const title = row.title || 'Your listing'
  if (action === 'approve') {
    await createNotification(row.host_id, {
      type: 'listing',
      title: 'Listing approved 🎉',
      body: `"${title}" was approved and is now live — guests can find and book it.`,
      link: '/host',
    })
  } else {
    await createNotification(row.host_id, {
      type: 'listing',
      title: 'Listing needs changes',
      body: // Composed from the SAME normalized note that was just stored, so the
      // notification and the reason on /host can never word it differently.
      listingRejectionMessage(title, reviewNote),
      link: '/host',
    })
  }
}

/** Publish / unpublish a listing.
 *  Publishing clears `unpublished_by_admin` — once an operator puts a listing back
 *  up by hand it is no longer "hidden by a block", so a later account restore must
 *  not claim it. Unpublishing deliberately does NOT set the flag: that would make a
 *  manual takedown get auto-republished when the host is unblocked. */
export async function adminSetListingPublished(id: string, published: boolean): Promise<void> {
  if (!isUuid(id)) throw new Error('Invalid listing')
  await pool.query(
    published
      ? `UPDATE listings SET is_published = true, unpublished_by_admin = false WHERE id = $1`
      : `UPDATE listings SET is_published = false WHERE id = $1`,
    [id],
  )
}

/**
 * The history behind the Overview's number cards — one dense series per chartable
 * metric, for the card → graph panel.
 *
 * TWO round trips for all eight metrics, not two per metric: the per-bucket counts
 * are one UNION ALL and the baselines are another. The Overview already polls
 * `adminStats` every 30 seconds from every operator's browser, so a fan-out of
 * sixteen queries behind a chart nobody has clicked yet is exactly the load this
 * screen cannot afford. The page fetches this once per range instead, and switching
 * cards is then free — every series is already on the client.
 *
 * `baseline` is what makes a running total honest: rows dated before the window
 * start. Without it the 7-day view would draw the platform's entire user base as
 * having arrived in the last week.
 *
 * Injection surface: `metric` is validated against METRIC_IDS by the route, and the
 * only interpolated identifiers are the constant from/where/at fragments that
 * METRICS keys off it. Dates are $n placeholders.
 */
export async function adminStatTrends(
  range: RangeId,
  now: Date = new Date(),
): Promise<TrendPayload> {
  const spec = RANGES[range]
  const buckets = bucketsFor(range, now)
  const { from, toExclusive } = windowFor(range, now)

  // date_trunc's unit is a constant from RANGES ('day' | 'month'), never user text.
  const bucketOf = (at: string) => `to_char(date_trunc('${spec.granularity}', ${at}), 'YYYY-MM-DD')`
  const scoped = (m: MetricSpec, extra: string) =>
    `FROM ${m.from} WHERE ${m.where ? `${m.where} AND ` : ''}${extra}`

  const ids = Object.keys(METRICS) as MetricId[]

  const countsSql = ids
    .map((id) => {
      const m = METRICS[id]
      return `SELECT '${id}' AS metric, ${bucketOf(m.at)} AS bucket, COUNT(*)::int AS count
                ${scoped(m, `${m.at} >= $1::date AND ${m.at} < $2::date`)}
               GROUP BY 2`
    })
    .join('\nUNION ALL\n')

  // A row with a NULL date axis has no bucket to sit in, so it can never appear in
  // the series — count it in the baseline instead of losing it, or the final
  // running total would fall short of the card.
  const baselineSql = ids
    .map((id) => {
      const m = METRICS[id]
      return `SELECT '${id}' AS metric, COUNT(*)::int AS count
                ${scoped(m, `(${m.at} IS NULL OR ${m.at} < $1::date)`)}`
    })
    .join('\nUNION ALL\n')

  const [counts, baselines] = await Promise.all([
    pool.query(countsSql, [from, toExclusive]),
    pool.query(baselineSql, [from]),
  ])

  const baselineOf = new Map<string, number>()
  for (const r of baselines.rows) baselineOf.set(r.metric, Number(r.count) || 0)

  const rowsOf = new Map<string, Array<{ bucket: string; count: number }>>()
  for (const r of counts.rows) {
    const list = rowsOf.get(r.metric) ?? []
    list.push({ bucket: r.bucket, count: Number(r.count) || 0 })
    rowsOf.set(r.metric, list)
  }

  const series = {} as Record<MetricId, SeriesPoint[]>
  for (const id of ids) {
    series[id] = buildSeries(buckets, rowsOf.get(id) ?? [], baselineOf.get(id) ?? 0, METRICS[id].cumulative)
  }

  // The whole response, not just the series: /ops/page.tsx seeds the client with
  // this on the server and the API route returns it verbatim, so assembling it here
  // is what stops the two paths shipping subtly different shapes.
  return { range, granularity: spec.granularity, series, metrics: publicMetrics() }
}

/** Top-line counts for the admin dashboard, plus the alert queues (F3/F4).
 *  gross_paid = SUM(total_price) of paid bookings — the HOST side, before the
 *  markup; commission_paid is the platform's cut on the same population, so
 *  gross_paid + commission_paid is what guests actually handed over. */
export async function adminStats(): Promise<AdminStats> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM users)::int AS users,
       (SELECT COUNT(*) FROM users WHERE is_host = true)::int AS hosts,
       -- users.verification_status is the source of truth (E2/E3), not the
       -- submission log — otherwise this tile disagrees with every badge the
       -- moment someone is verified without a matching id_verifications row.
       (SELECT COUNT(*) FROM users WHERE verification_status = 'verified')::int AS verified,
       (SELECT COUNT(*) FROM listings)::int AS listings,
       (SELECT COUNT(*) FROM listings WHERE is_published = true)::int AS published,
       (SELECT COUNT(*) FROM bookings)::int AS bookings,
       (SELECT COUNT(*) FROM bookings WHERE status = 'pending')::int AS pending_bookings,
       (SELECT COUNT(*) FROM bookings WHERE status = 'confirmed')::int AS confirmed_bookings,
       -- payment_status, NOT "paid_at IS NOT NULL": a refund CLEARS paid_at, so that
       -- predicate silently under-counted. Same rule as analytics-core's PAID_SQL.
       (SELECT COUNT(*) FROM bookings WHERE COALESCE(payment_status, 'unpaid') = 'paid')::int AS paid_bookings,
       (SELECT COUNT(*) FROM host_applications WHERE status = 'pending')::int AS pending_applications,
       (SELECT COUNT(*) FROM id_verifications WHERE status = 'pending')::int AS pending_verifications,
       COALESCE((SELECT SUM(total_price) FROM bookings WHERE COALESCE(payment_status, 'unpaid') = 'paid'), 0)::float8 AS gross_paid,
       -- The platform's margin. Because the commission is a MARKUP, it is the gap
       -- between what the guest was charged and the host's raw price — not a
       -- percentage of total_price, which would ignore the round-up to 10 EGP.
       -- Each booking prices at ITS OWN snapshot, so changing the rate never
       -- restates what has already been earned.
       COALESCE((SELECT SUM(${COMMISSION_AMOUNT_SQL}) FROM bookings b
                  WHERE COALESCE(b.payment_status, 'unpaid') = 'paid'), 0)::float8 AS commission_paid,
       -- Expected, not earned: live reservations with the money still outstanding.
       -- Cancelled/rejected bookings and refunded ones are excluded — that money is
       -- never arriving.
       COALESCE((SELECT SUM(${COMMISSION_AMOUNT_SQL}) FROM bookings b
                  WHERE b.status IN ('pending', 'confirmed')
                    AND COALESCE(b.payment_status, 'unpaid') NOT IN ('paid', 'refunded', 'voided')), 0)::float8 AS commission_pending,
       -- F3/F4: the queues that need someone's attention. These drive both the
       -- dashboard's alert tiles and the alert centre, so they live in the same single
       -- query rather than fanning out per poll.
       (SELECT COUNT(*) FROM bookings WHERE created_at >= date_trunc('day', now()))::int AS bookings_today,
       (SELECT COUNT(*) FROM listings WHERE COALESCE(approval_status, 'approved') = 'pending')::int AS pending_listings,
       -- Only the LATEST proof per booking counts — an old disputed proof superseded by
       -- a fresh one is not an open dispute. Mirrors adminListDisputes.
       (SELECT COUNT(*) FROM payment_proofs pp
         WHERE pp.status = 'disputed'
           AND pp.id = (SELECT id FROM payment_proofs p2 WHERE p2.booking_id = pp.booking_id
                         ORDER BY p2.submitted_at DESC LIMIT 1))::int AS disputed_payments,
       -- Transfers waiting for a first decision. Nothing counted these before, so a
       -- guest could pay and no one would ever be told.
       (SELECT COUNT(*) FROM payment_proofs pp
         WHERE pp.status = 'submitted'
           AND pp.id = (SELECT id FROM payment_proofs p2 WHERE p2.booking_id = pp.booking_id
                         ORDER BY p2.submitted_at DESC LIMIT 1))::int AS pending_payments,
       (SELECT COUNT(*) FROM resort_submissions WHERE status = 'pending')::int AS pending_resort_submissions,
       (SELECT COUNT(*) FROM reports WHERE status = 'open')::int AS open_reports,
       -- How long the oldest item in each queue has waited, so the alert centre can say
       -- "3 days" rather than just a number.
       (SELECT to_char((MIN(submitted_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM id_verifications WHERE status = 'pending') AS oldest_verification,
       (SELECT to_char((MIN(submitted_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM host_applications WHERE status = 'pending') AS oldest_application,
       (SELECT to_char((MIN(created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM listings WHERE COALESCE(approval_status, 'approved') = 'pending') AS oldest_listing,
       (SELECT to_char((MIN(created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM reports WHERE status = 'open') AS oldest_report,
       (SELECT to_char((MIN(submitted_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM payment_proofs WHERE status = 'submitted') AS oldest_payment`
  )
  // The two newest queues are read through their own helpers rather than as
  // subqueries above, ON PURPOSE: a subquery against a table that doesn't exist
  // yet fails the WHOLE statement, which would take the dashboard and the alert
  // centre down on any database where migrate-policy-violations / migrate-disputes
  // hasn't run. Each helper answers 0 in that case, so the console degrades to
  // "nothing in this queue" instead of breaking.
  const [flagged_users, open_disputes, pending_id_changes, oldest_flag, oldest_dispute, oldest_id_change] =
    await Promise.all([
      countFlaggedUsers(),
      countOpenDisputes(),
      countPendingIdChanges(),
      oldestFlaggedAt(),
      oldestOpenDisputeAt(),
      oldestPendingIdChangeAt(),
    ])
  return {
    ...(rows[0] as AdminStats),
    flagged_users,
    open_disputes,
    pending_id_changes,
    oldest_flag,
    oldest_dispute,
    oldest_id_change,
  }
}

/**
 * Verify a reset code without consuming it. A wrong code increments the attempt
 * counter (so guessing is bounded); the row is only marked used once the password
 * has actually been changed — same ordering as HubDrives' Verify()/MarkUsed().
 */
export async function checkStaffReset(
  email: string,
  code: string,
  maxAttempts: number
): Promise<{ ok: true; id: string; staffId: string } | { ok: false; reason: 'not_found' | 'expired' | 'used' | 'locked' | 'mismatch' }> {
  const { rows } = await pool.query<{
    id: string
    staff_id: string
    code: string
    used_at: string | null
    failed_attempts: number
    expired: boolean
  }>(
    `SELECT id, staff_id, code, used_at, failed_attempts, (expires_at <= now()) AS expired
       FROM staff_password_resets
      WHERE lower(email) = lower($1)
      ORDER BY created_at DESC LIMIT 1`,
    [email]
  )
  const row = rows[0]
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.used_at) return { ok: false, reason: 'used' }
  if (row.failed_attempts >= maxAttempts) return { ok: false, reason: 'locked' }
  if (row.expired) return { ok: false, reason: 'expired' }
  if (row.code !== String(code).trim()) {
    await pool.query(
      `UPDATE staff_password_resets SET failed_attempts = failed_attempts + 1 WHERE id = $1`,
      [row.id]
    )
    return { ok: false, reason: 'mismatch' }
  }
  return { ok: true, id: row.id, staffId: row.staff_id }
}

export async function createStaffAccount(input: {
  email: string
  passwordHash: string
  fullName: string
  role: 'super_admin' | 'moderator'
  createdBy: string | null
  modules: string[]
}): Promise<StaffAccount> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO staff_accounts (email, password_hash, full_name, role, created_by)
       VALUES (lower($1), $2, $3, $4, $5) RETURNING id`,
      [input.email.trim(), input.passwordHash, input.fullName.trim().slice(0, 120), input.role,
       input.createdBy && isUuid(input.createdBy) ? input.createdBy : null]
    )
    const id = rows[0].id
    if (input.role === 'moderator' && input.modules.length) {
      await client.query(
        `INSERT INTO staff_permissions (staff_id, module, granted_by)
         SELECT $1, m, $2 FROM unnest($3::text[]) AS m
         ON CONFLICT (staff_id, module) DO NOTHING`,
        [id, input.createdBy && isUuid(input.createdBy) ? input.createdBy : null, input.modules]
      )
    }
    await client.query('COMMIT')
    return (await getStaffAccount(id))!
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Invalidates any outstanding codes for the account, then issues a fresh one. */
export async function createStaffReset(input: {
  staffId: string
  email: string
  code: string
  ttlMs: number
  ip: string | null
}): Promise<void> {
  if (!isUuid(input.staffId)) throw new Error('Invalid id')
  await pool.query(
    `UPDATE staff_password_resets SET used_at = now()
      WHERE staff_id = $1 AND used_at IS NULL`,
    [input.staffId]
  )
  await pool.query(
    `INSERT INTO staff_password_resets (staff_id, email, code, expires_at, request_ip)
     VALUES ($1, lower($2), $3, now() + ($4 || ' milliseconds')::interval, $5)`,
    [input.staffId, input.email, input.code, String(input.ttlMs), input.ip]
  )
}

/**
 * Everything that happened on the site, newest first.
 *
 * There is NO activity_log table. Six of the seven kinds are derived from timestamps
 * already sitting on real rows, so this feed has full history from the day it shipped
 * rather than starting empty — and it cannot drift from the data it describes, because
 * it IS the data. `login` is the exception and has its own table.
 *
 * Each branch is date-windowed and LIMITed BEFORE the union, so every one uses its own
 * created_at index instead of sorting a whole table; the outer query only merges an
 * already-small set. Branches the filter excludes are not emitted at all.
 */
export async function getActivityFeed(
  filter: ActivityFilter,
): Promise<{ events: ActivityEvent[]; hasMore: boolean }> {
  const params: unknown[] = []
  const bind = (v: unknown) => `$${params.push(v)}`

  // One shared window; `to` widens to the whole final day.
  const from = filter.from ? bind(filter.from) : null
  const to = filter.to ? bind(filter.to) : null
  const windowFor = (col: string) => {
    const parts: string[] = [`${col} IS NOT NULL`]
    if (from) parts.push(`${col} >= ${from}::date`)
    if (to) parts.push(`${col} < (${to}::date + interval '1 day')`)
    return parts.join(' AND ')
  }
  const cap = bind(branchLimit(filter))
  const search = filter.q ? bind(`%${filter.q}%`) : null
  // Applied to the actor, whoever that is for the branch in question.
  const match = (email: string, name: string) =>
    search ? ` AND (${email} ILIKE ${search} OR COALESCE(${name}, '') ILIKE ${search})` : ''

  const branches: string[] = []

  if (wantsKind(filter, 'signup')) branches.push(`
    (SELECT 'signup' AS kind, u.created_at AS at, u.id AS actor_id, u.email AS actor_email,
            u.full_name AS actor_name, NULL::text AS subject, 'user' AS subject_type,
            u.id::text AS subject_id, NULL::float8 AS amount,
            CASE WHEN COALESCE(u.is_host, false) THEN 'host' ELSE 'guest' END AS detail
       FROM users u
      WHERE ${windowFor('u.created_at')}${match('u.email', 'u.full_name')}
      ORDER BY u.created_at DESC LIMIT ${cap})`)

  if (wantsKind(filter, 'login')) branches.push(`
    (SELECT 'login' AS kind, lg.created_at AS at, u.id AS actor_id, u.email AS actor_email,
            u.full_name AS actor_name, NULL::text AS subject, 'user' AS subject_type,
            u.id::text AS subject_id, NULL::float8 AS amount, lg.method AS detail
       FROM user_logins lg JOIN users u ON u.id = lg.user_id
      WHERE ${windowFor('lg.created_at')}${match('u.email', 'u.full_name')}
      ORDER BY lg.created_at DESC LIMIT ${cap})`)

  if (wantsKind(filter, 'listing_created')) branches.push(`
    (SELECT 'listing_created' AS kind, l.created_at AS at, u.id AS actor_id, u.email AS actor_email,
            u.full_name AS actor_name, l.title AS subject, 'listing' AS subject_type,
            l.id::text AS subject_id, l.price_per_night::float8 AS amount,
            COALESCE(l.approval_status, 'approved') AS detail
       FROM listings l LEFT JOIN users u ON u.id = l.host_id
      WHERE ${windowFor('l.created_at')}${match("COALESCE(u.email, '')", 'u.full_name')}
      ORDER BY l.created_at DESC LIMIT ${cap})`)

  if (wantsKind(filter, 'booking_created')) branches.push(`
    (SELECT 'booking_created' AS kind, b.created_at AS at, u.id AS actor_id, u.email AS actor_email,
            u.full_name AS actor_name, l.title AS subject, 'booking' AS subject_type,
            b.id::text AS subject_id, ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)}::float8 AS amount, b.status AS detail
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
                       LEFT JOIN listings l ON l.id = b.listing_id
      WHERE ${windowFor('b.created_at')}${match("COALESCE(u.email, '')", 'u.full_name')}
      ORDER BY b.created_at DESC LIMIT ${cap})`)

  if (wantsKind(filter, 'payment_submitted')) branches.push(`
    (SELECT 'payment_submitted' AS kind, pp.submitted_at AS at, u.id AS actor_id, u.email AS actor_email,
            u.full_name AS actor_name, l.title AS subject, 'booking' AS subject_type,
            b.id::text AS subject_id, COALESCE(pp.amount, ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)})::float8 AS amount,
            pp.status AS detail
       FROM payment_proofs pp JOIN bookings b ON b.id = pp.booking_id
                              LEFT JOIN users u ON u.id = b.user_id
                              LEFT JOIN listings l ON l.id = b.listing_id
      WHERE ${windowFor('pp.submitted_at')}${match("COALESCE(u.email, '')", 'u.full_name')}
      ORDER BY pp.submitted_at DESC LIMIT ${cap})`)

  // NB the paid_at trap: it is NULLed on refund. Gating on PAID_SQL means this branch
  // shows payments that are still paid, and a refund shows up as its own money event
  // rather than a payment that silently vanished.
  if (wantsKind(filter, 'payment_approved')) branches.push(`
    (SELECT 'payment_approved' AS kind, b.paid_at AS at, u.id AS actor_id, u.email AS actor_email,
            u.full_name AS actor_name, l.title AS subject, 'booking' AS subject_type,
            b.id::text AS subject_id, ${sqlWithCommission('b.total_price', BOOKING_RATE_SQL)}::float8 AS amount, b.payment_status AS detail
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
                       LEFT JOIN listings l ON l.id = b.listing_id
      WHERE ${windowFor('b.paid_at')} AND ${PAID_SQL}${match("COALESCE(u.email, '')", 'u.full_name')}
      ORDER BY b.paid_at DESC LIMIT ${cap})`)

  if (wantsKind(filter, 'booking_cancelled')) branches.push(`
    (SELECT 'booking_cancelled' AS kind, b.cancelled_at AS at, u.id AS actor_id, u.email AS actor_email,
            u.full_name AS actor_name, l.title AS subject, 'booking' AS subject_type,
            b.id::text AS subject_id, b.refund_amount::float8 AS amount,
            COALESCE(b.cancelled_by_role, 'guest') AS detail
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
                       LEFT JOIN listings l ON l.id = b.listing_id
      WHERE ${windowFor('b.cancelled_at')}${match("COALESCE(u.email, '')", 'u.full_name')}
      ORDER BY b.cancelled_at DESC LIMIT ${cap})`)

  if (branches.length === 0) return { events: [], hasMore: false }

  const dir = filter.sort === 'oldest' ? 'ASC' : 'DESC'
  // Fetch one extra row so the client knows whether a next page exists without a
  // COUNT over a seven-branch union.
  const limit = bind(filter.limit + 1)
  const offset = bind(filter.offset)
  const { rows } = await pool.query(
    `SELECT kind, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, actor_id, actor_email,
            actor_name, subject, subject_type, subject_id, amount, detail
       FROM (${branches.join('\n    UNION ALL')}) e
      ORDER BY at ${dir}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const hasMore = rows.length > filter.limit
  return { events: rows.slice(0, filter.limit) as ActivityEvent[], hasMore }
}

/** The mobile app store links surfaced by the web "download the app" bar.
 *  Returns nulls when nothing is configured yet (or the table doesn't exist),
 *  so the public banner endpoint never errors. */
export async function getAppLinks(): Promise<AppLinks> {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('app_ios_url', 'app_android_url')`
    )
    const norm = (v: unknown): string | null => {
      const s = String(v ?? '').trim()
      return s || null
    }
    const map = new Map(rows.map((r) => [r.key as string, r.value as string | null]))
    return { ios: norm(map.get('app_ios_url')), android: norm(map.get('app_android_url')) }
  } catch {
    // Table not created yet → treat as "no links configured".
    return { ios: null, android: null }
  }
}

/** The distinct actions actually present, for the filter dropdown — so it offers what
 *  this deployment has really recorded rather than a hardcoded list that drifts. */
export async function getAuditActions(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT action FROM staff_audit_log ORDER BY action`,
  )
  return rows.map((r) => String(r.action))
}

/**
 * The staff audit trail (F2).
 *
 * staff_audit_log has been written since the RBAC work landed but NEVER read — until
 * this, the only way to answer "who deleted that?" was psql against Neon. The table
 * itself needed no change; it needed a reader.
 *
 * `action` and `target_type` arrive pre-validated as plain slugs (parseAuditFilter)
 * and are still bound, never interpolated.
 */
export async function getAuditLog(
  filter: AuditFilter,
): Promise<{ entries: AuditEntry[]; hasMore: boolean }> {
  const where: string[] = []
  const params: unknown[] = []
  const bind = (v: unknown) => `$${params.push(v)}`

  if (filter.q) where.push(`COALESCE(staff_email, '') ILIKE ${bind(`%${filter.q}%`)}`)
  if (filter.action) where.push(`action = ${bind(filter.action)}`)
  if (filter.targetType) where.push(`target_type = ${bind(filter.targetType)}`)
  if (filter.from) where.push(`created_at >= ${bind(filter.from)}::date`)
  if (filter.to) where.push(`created_at < (${bind(filter.to)}::date + interval '1 day')`)

  const limit = bind(filter.limit + 1)
  const offset = bind(filter.offset)
  const { rows } = await pool.query(
    `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
            staff_id, staff_email, action, target_type, target_id, detail, ip
       FROM staff_audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const hasMore = rows.length > filter.limit
  return { entries: rows.slice(0, filter.limit) as AuditEntry[], hasMore }
}

/** How many listings and services the current rate is repricing. Shown on the
 *  admin screen so an operator sees the blast radius before they change it. */
export async function getCommissionImpact(): Promise<{ listings: number; services: number }> {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM listings WHERE is_published = true)::int AS listings,
            (SELECT count(*) FROM services WHERE is_published = true)::int AS services`
  )
  return { listings: Number(rows[0]?.listings ?? 0), services: Number(rows[0]?.services ?? 0) }
}

/** The admin queue. Defaults to the applications still awaiting a decision;
 *  `status` accepts 'pending' | 'approved' | 'rejected' | 'all'. */
export async function getPendingHostApplications(status: string = 'pending'): Promise<HostApplication[]> {
  const filter = ['pending', 'approved', 'rejected'].includes(status) ? status : null
  const { rows } = await pool.query(
    // The linked ID submission rides along so the reviewer can open the document
    // before approving — approving an application now verifies the identity too,
    // and approving that blind would defeat the point of the check.
    `SELECT a.id, a.user_id, a.full_name, a.national_id, a.phone, a.address, a.company, a.notes, a.status,
            to_char(a.submitted_at,'YYYY-MM-DD HH24:MI') AS submitted_at,
            to_char(a.reviewed_at,'YYYY-MM-DD HH24:MI') AS reviewed_at, a.review_note,
            u.email, u.host_type,
            a.verification_id,
            (SELECT v.doc_type FROM id_verifications v WHERE v.id = a.verification_id) AS doc_type,
            (SELECT v.status   FROM id_verifications v WHERE v.id = a.verification_id) AS verification_status
       FROM host_applications a JOIN users u ON u.id = a.user_id
      WHERE ($1::text IS NULL OR a.status = $1) ORDER BY a.submitted_at ASC`,
    [filter]
  )
  return rows as HostApplication[]
}

/** The /ops verification queue. `filter` defaults to 'pending' — the work list —
 *  but a decided case can be found again and reopened. */
export async function getPendingVerifications(
  filter: VerificationFilter = 'pending',
): Promise<AdminVerificationRow[]> {
  const { rows } = await pool.query(
    `SELECT v.id, v.user_id, u.email, v.full_name, v.id_number, v.status,
            (v.image_data        IS NOT NULL AND v.image_data        <> '') AS has_front,
            (v.back_image_data   IS NOT NULL AND v.back_image_data   <> '') AS has_back,
            (v.selfie_image_data IS NOT NULL AND v.selfie_image_data <> '') AS has_selfie,
            to_char(v.submitted_at,'YYYY-MM-DD HH24:MI') AS submitted_at,
            to_char(v.reviewed_at, 'YYYY-MM-DD HH24:MI') AS reviewed_at,
            v.reviewed_by, v.notes
       FROM id_verifications v JOIN users u ON u.id = v.user_id
      WHERE ($1 = 'all' OR v.status = $1)
      ORDER BY v.submitted_at ASC
      LIMIT 300`,
    [filter],
  )
  return rows as AdminVerificationRow[]
}

/** Login lookup. Returns the hash and lockout state; case-insensitive on email. */
export async function getStaffByEmail(email: string): Promise<{
  id: string
  email: string
  password_hash: string
  full_name: string
  role: 'super_admin' | 'moderator'
  is_active: boolean
  failed_login_attempts: number
  locked_until: string | null
} | null> {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, full_name, role, is_active,
            failed_login_attempts, locked_until
       FROM staff_accounts WHERE lower(email) = lower($1)`,
    [email]
  )
  return rows[0] ?? null
}

/** Newest-last list for the staff screen: super admins first, then by creation. */
export async function listStaffAccounts(): Promise<StaffAccount[]> {
  const { rows } = await pool.query<StaffAccount>(
    `${STAFF_SELECT}
      GROUP BY a.id, c.email
      ORDER BY (a.role = 'super_admin') DESC, a.created_at`
  )
  return rows
}

/** Consume the code. Call only after the new password is committed. */
export async function markStaffResetUsed(id: string): Promise<void> {
  await pool.query(`UPDATE staff_password_resets SET used_at = now() WHERE id = $1`, [id])
}

/** Count a failed sign-in and lock the account once the threshold is hit.
 *  Per-account columns rather than the in-memory limiter, which dies on cold start
 *  and isn't shared across serverless instances. Returns the post-update state. */
export async function noteStaffLoginFailure(
  id: string,
  maxAttempts: number,
  lockoutMs: number
): Promise<{ attempts: number; lockedUntil: string | null }> {
  const { rows } = await pool.query<{ failed_login_attempts: number; locked_until: string | null }>(
    `UPDATE staff_accounts
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE WHEN failed_login_attempts + 1 >= $2
                                THEN now() + ($3 || ' milliseconds')::interval
                                ELSE locked_until END,
            updated_at = now()
      WHERE id = $1
      RETURNING failed_login_attempts, locked_until`,
    [id, maxAttempts, String(lockoutMs)]
  )
  return { attempts: rows[0]?.failed_login_attempts ?? 0, lockedUntil: rows[0]?.locked_until ?? null }
}

/** Clear the failure counter and stamp the successful sign-in. */
export async function noteStaffLoginSuccess(id: string): Promise<void> {
  await pool.query(
    `UPDATE staff_accounts
        SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
      WHERE id = $1`,
    [id]
  )
}

/** Housekeeping for the daily cron — sessions and reset codes accumulate forever. */
export async function purgeStaffExpired(): Promise<{ sessions: number; resets: number; logins: number }> {
  const s = await pool.query(
    `DELETE FROM staff_sessions WHERE expires_at < now() - interval '30 days'`
  )
  const r = await pool.query(
    `DELETE FROM staff_password_resets
      WHERE created_at < now() - interval '30 days' AND (used_at IS NOT NULL OR expires_at < now())`
  )
  // user_logins carries an IP and a user agent per sign-in — real PII, and unbounded.
  // 90 days is long enough to investigate an incident and short enough that the table
  // isn't a standing liability.
  const l = await pool.query(`DELETE FROM user_logins WHERE created_at < now() - interval '90 days'`)
  return { sessions: s.rowCount ?? 0, resets: r.rowCount ?? 0, logins: l.rowCount ?? 0 }
}

/**
 * Write a document-view audit row — and THROW if it fails.
 *
 * Deliberately not `logStaffAction` (staff.ts), which swallows every error by
 * contract so an audit hiccup can't break the action being audited. That trade is
 * right for a block/unblock: losing the log is worse than losing the action. Here it
 * inverts — "log who viewed what" IS the feature, so an unlogged view is the exact
 * outcome E4 exists to prevent. No log, no bytes.
 *
 * Do not "fix" the inconsistency by routing this through logStaffAction.
 */
export async function recordDocumentView(entry: {
  staffId: string | null
  staffEmail: string | null
  targetType: 'user' | 'listing'
  targetId: string
  detail: unknown
  ip: string | null
}): Promise<void> {
  await pool.query(
    `INSERT INTO staff_audit_log (staff_id, staff_email, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, 'document_viewed', $3, $4, $5::jsonb, $6)`,
    [entry.staffId, entry.staffEmail, entry.targetType, entry.targetId, JSON.stringify(entry.detail), entry.ip],
  )
}

/**
 * Admin decision on an ID submission — the one writer of a user's verified state.
 *
 * Writes BOTH tables in one transaction: `id_verifications` is the submission log,
 * `users.verification_status` is the source of truth every badge reads (mobile
 * `getUserBadges`, `host_verified` on every listing payload, and the web host
 * profile). They used to disagree — /ops wrote only the submission row, so the
 * apps' verified badges were permanently dark and `users.verified_at` was never
 * written at all.
 *
 * `action: 'pending'` reopens a decided case, clearing the review so it returns to
 * the queue. `actor` is `staff:<uuid>`, replacing the hardcoded 'admin' that
 * discarded who actually decided.
 */
export async function reviewVerification(
  verifId: string,
  action: VerificationAction,
  note: string | null,
  actor: string,
): Promise<void> {
  if (!isUuid(verifId)) throw new Error('Invalid verification')
  const status = statusForAction(action)
  const client = await pool.connect()
  let uid = ''
  let listingsHidden = 0
  let listingsRestored = 0
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      // Reopening clears the review; deciding stamps it.
      `UPDATE id_verifications
          SET status = $2,
              reviewed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END,
              reviewed_by = CASE WHEN $2 = 'pending' THEN NULL ELSE $4 END,
              notes = $3
        WHERE id = $1 RETURNING user_id`,
      [verifId, status, note, actor],
    )
    uid = rows[0]?.user_id ?? ''
    if (!uid) throw new Error('Verification not found')
    // Read the OLD status before overwriting it — losing verification has to take
    // the host's listings off the market, and that is only knowable by comparing.
    const prev = await client.query(
      `SELECT COALESCE(verification_status, 'unverified') AS status FROM users WHERE id = $1`,
      [uid],
    )
    const previousStatus = prev.rows[0]?.status ?? 'unverified'
    await client.query(
      `UPDATE users
          SET verification_status = $2,
              verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE NULL END
        WHERE id = $1`,
      [uid, status],
    )

    // A host who is no longer verified must not keep listings in front of guests
    // — that is the whole point of the gate. Flagged with a dedicated column so
    // re-verifying restores exactly these and nothing else; sharing the account
    // block's unpublished_by_admin flag would let unblocking republish listings
    // that verification had hidden.
    if (revokesListingPrivileges(previousStatus, status)) {
      const hid = await client.query(
        `UPDATE listings SET is_published = false, unpublished_by_verification = true
          WHERE host_id = $1 AND is_published = true`,
        [uid],
      )
      listingsHidden = hid.rowCount ?? 0
    } else if (normalizeVerificationStatus(status) === 'verified') {
      // Restore only what verification hid, and only if the account is not ALSO
      // blocked — the two reasons compose, so a listing hidden for both stays
      // hidden until both clear.
      const shown = await client.query(
        `UPDATE listings SET is_published = true, unpublished_by_verification = false
          WHERE host_id = $1 AND unpublished_by_verification = true
            AND COALESCE(unpublished_by_admin, false) = false`,
        [uid],
      )
      listingsRestored = shown.rowCount ?? 0
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  // Reopening is an internal correction — don't tell the user their ID "changed".
  // It can still have unpublished their listings, so that is reported separately.
  if (action === 'pending') {
    if (listingsHidden > 0) {
      await createNotification(uid, { type: 'verification', title: 'Listings paused', body: `We're re-checking your identity documents. ${listingsHidden} listing${listingsHidden === 1 ? ' is' : 's are'} paused until that's done.`, link: '/host' })
    }
    return
  }
  const verified = action === 'verify'
  // Say what happened to their listings — a host whose listings vanished with no
  // explanation will open a support ticket.
  const listingNote = verified
    ? (listingsRestored > 0
        ? ` ${listingsRestored} listing${listingsRestored === 1 ? '' : 's'} ${listingsRestored === 1 ? 'is' : 'are'} live again.`
        : '')
    : (listingsHidden > 0
        ? ` ${listingsHidden} listing${listingsHidden === 1 ? '' : 's'} ${listingsHidden === 1 ? 'has' : 'have'} been paused until you're verified.`
        : '')
  await createNotification(uid, {
      type: 'verification',
      title: verified ? 'Identity verified' : 'Identity check update',
      body: (verified
      ? 'Your ID was verified — your account is now verified and you can publish listings.'
      : (note ? `We could not verify your ID: ${note}` : 'We could not verify your ID. Please re-submit a clear photo.')
    ) + listingNote,
      link: verified ? '/host' : '/verify-id',
    })
}

/** Persist the app store links (admin only). Creates the settings table on
 *  first use so no separate migration is needed. Pass null to clear a link. */
export async function setAppLinks(ios: string | null, android: string | null): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS app_settings (
       key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now()
     )`
  )
  const upsert = async (key: string, value: string | null) => {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    )
  }
  await upsert('app_ios_url', ios)
  await upsert('app_android_url', android)
}

/** Set a new password and clear any lockout. Callers must also revoke sessions. */
export async function setStaffPassword(id: string, passwordHash: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const { rowCount } = await pool.query(
    `UPDATE staff_accounts
        SET password_hash = $2, password_changed_at = now(), updated_at = now(),
            failed_login_attempts = 0, locked_until = NULL
      WHERE id = $1`,
    [id, passwordHash]
  )
  return (rowCount ?? 0) > 0
}

/** The projection the /ops users list renders. Kept as a fragment so the list and
 *  the profile header agree on what a user row looks like. `u` is the users alias. */
const ADMIN_USER_COLS = `
  u.id, u.email, u.full_name, COALESCE(u.is_host, false) AS is_host,
  COALESCE(u.email_verified, false) AS email_verified,
  COALESCE(
    (SELECT v.status FROM id_verifications v
      WHERE v.user_id = u.id ORDER BY v.submitted_at DESC LIMIT 1),
    'none'
  ) AS verification_status,
  u.provider,
  u.push_platform,
  (u.fcm_token IS NOT NULL OR EXISTS (SELECT 1 FROM device_tokens dt WHERE dt.user_id = u.id)) AS has_push,
  (SELECT string_agg(DISTINCT dt.platform, ', ') FROM device_tokens dt WHERE dt.user_id = u.id) AS device_platforms,
  (SELECT COUNT(*) FROM device_tokens dt WHERE dt.user_id = u.id)::int AS device_count,
  to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  (SELECT COUNT(*) FROM listings l WHERE l.host_id = u.id)::int AS listing_count,
  (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id)::int AS booking_count,
  COALESCE(u.account_status, 'active') AS account_status,
  u.status_reason,
  to_char(u.status_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS status_changed_at,
  u.status_changed_by
`
export interface ActivityEvent {
  kind: string
  at: string
  actor_id: string | null
  actor_email: string | null
  actor_name: string | null
  /** What the event was about — a listing title, a reservation code, an amount. */
  subject: string | null
  subject_type: string | null
  subject_id: string | null
  /** Money, where the event has any. */
  amount: number | null
  detail: string | null
}

export interface AdminBookingRow {
  id: string
  /** NULL until the booking is confirmed (see genReservationCode). */
  reservation_code: string | null
  status: string
  payment_status: string
  /** Commission-inclusive — what the guest owes. */
  total_price: number
  /** The host's raw share of it. */
  host_payout: number
  /** The platform's cut: total_price − host_payout, at this booking's own rate. */
  commission: number
  /** The rate this booking was taken at, as a fraction. Snapshot, not the live rate. */
  commission_rate: number
  currency: string
  check_in: string
  check_out: string
  guest_name: string | null
  guest_email: string | null
  listing_title: string | null
  created_at: string
}

export interface AdminListingRow {
  id: string
  title: string
  location: string | null
  region: string | null
  /** The three fields the pin badge is derived from — see listing-geo-policy.ts.
   *  Nothing about the mismatch is stored: the console recomputes it per row, so
   *  a host who fixes their pin clears the badge on the next load. */
  country: string | null
  lat: number | null
  lng: number | null
  /** Set when the host picked from the catalog. */
  resort_id: string | null
  /** Set when the host typed their own via "Other" — this is what needs review
   *  before the listing is approved. Never set at the same time as resort_id. */
  resort_name: string | null
  /** Display name, whichever column it came from. */
  resort: string | null
  currency: string
  /** Commission-inclusive — what a guest is quoted. */
  price_per_night: number
  /** The host's raw price, before the platform commission. */
  host_price_per_night: number
  is_published: boolean
  approval_status: string
  host_id: string | null
  host_name: string | null
  created_at: string
  booking_count: number
  image: string | null
  /** True when the host attached a proof-of-ownership document. The document ITSELF
   *  is no longer shipped here — it comes one at a time from the audited
   *  /api/local/admin/documents/ownership/:id, which needs the `documents` module
   *  and records who opened it. This payload used to carry the inline base64 for
   *  every pending listing, to anyone holding `listings`, with no record at all. */
  has_ownership_doc: boolean
}

export interface AdminPendingBookingRow {
  id: string
  reservation_code: string | null
  status: string
  payment_status: string
  total_price: number
  currency: string
  check_in: string
  check_out: string
  guests: number
  guest_name: string | null
  guest_email: string | null
  listing_title: string | null
  listing_location: string | null
  host_name: string | null
  host_email: string | null
  host_id: string | null
  image: string | null
  created_at: string
}

export interface AdminReport {
  id: string
  reporter_id: string | null
  reporter_name: string | null
  reporter_email: string | null
  target_type: string
  target_id: string
  /** Who or what was reported, resolved to something readable. */
  target_label: string | null
  reason: string | null
  details: string | null
  status: string
  created_at: string
  resolved_at: string | null
}

export interface AdminStats {
  users: number
  hosts: number
  verified: number
  listings: number
  published: number
  bookings: number
  pending_bookings: number
  confirmed_bookings: number
  paid_bookings: number
  pending_applications: number
  pending_verifications: number
  /** Requests to change an account's ID number, awaiting a decision. */
  pending_id_changes: number
  gross_paid: number
  /** The platform's cut — guest price minus the host's raw price — summed over
   *  bookings that were actually collected. Refunded rows drop out with PAID_SQL. */
  commission_paid: number
  /** The same cut on bookings still expected to be collected: live reservations
   *  that have not been paid yet. Expected, not earned. */
  commission_pending: number
  /** F3/F4 — the "needs attention" counts behind the alert tiles and the alert centre. */
  bookings_today: number
  pending_listings: number
  disputed_payments: number
  /** Transfer screenshots waiting for an accept/reject. */
  pending_payments: number
  pending_resort_submissions: number
  open_reports: number
  /** Users with unreviewed content-guard blocks (F5) — the Moderation queue. */
  flagged_users: number
  /** Guest disputes still open or in review — the Disputes queue. */
  open_disputes: number
  /** When the oldest item in each queue arrived, so an alert can show how long it has waited. */
  oldest_verification: string | null
  oldest_id_change: string | null
  oldest_application: string | null
  oldest_listing: string | null
  oldest_report: string | null
  oldest_payment: string | null
  oldest_flag: string | null
  oldest_dispute: string | null
}

export interface AdminThreadMessage {
  id: string
  sender_id: string
  sender_name: string | null
  body: string
  created_at: string
}

export interface AdminUserBooking {
  id: string
  reservation_code: string | null
  listing_id: string | null
  listing_title: string | null
  status: string
  payment_status: string
  total_price: number
  currency: string
  check_in: string
  check_out: string
  created_at: string
}

export interface AdminUserConversation {
  id: string
  listing_id: string | null
  listing_title: string | null
  counterparty_id: string | null
  counterparty_name: string | null
  counterparty_email: string | null
  message_count: number
  last_message_at: string | null
  /** Which side of the thread this user is on. */
  viewer_role: 'guest' | 'host'
}

export interface AdminUserDetail {
  user: AdminUserRow & {
    phone: string | null
    country: string | null
    bio: string | null
    avatar_url: string | null
    role: string | null
    host_type: string | null
    company: string | null
    referral_code: string | null
  }
  listings: AdminUserListing[]
  bookings: AdminUserBooking[]
  payments: AdminUserPayment[]
  conversations: AdminUserConversation[]
  documents: AdminUserDocument[]
  stats: {
    gross_paid: number
    nights_booked: number
    /** Booking-scoped mobile messages. Those threads have a different shape from
     *  the web `conversations` above, so they're counted rather than merged. */
    mobile_message_count: number
    report_count: number
  }
}

export interface AdminUserDocument {
  kind: 'id_verification' | 'host_application'
  id: string
  status: string
  submitted_at: string | null
  reviewed_at: string | null
  notes: string | null
  /** Whether a document image is on file. The image itself is NOT returned — it's
   *  reviewed on the Verifications screen, and a profile shouldn't ship megabytes
   *  of inline base64 (or that much PII) on every open. */
  has_document: boolean
}

export interface AdminUserListing {
  id: string
  title: string
  is_published: boolean
  approval_status: string
  /** True when a block/removal took this listing down — so /ops can say WHY it's
   *  hidden rather than leaving the operator guessing. */
  unpublished_by_admin: boolean
  price_per_night: number
  currency: string
  created_at: string
  booking_count: number
}

export interface AdminUserPayment {
  id: string
  booking_id: string
  reservation_code: string | null
  listing_title: string | null
  amount: number
  status: string
  submitted_at: string | null
  reviewed_at: string | null
  reject_reason: string | null
}

export interface AdminUserRow {
  id: string
  email: string
  full_name: string | null
  is_host: boolean
  email_verified: boolean
  verification_status: string
  provider: string
  push_platform: string | null
  has_push: boolean
  device_platforms: string | null
  device_count: number
  created_at: string
  listing_count: number
  booking_count: number
  /** D3/D4 lifecycle — 'active' | 'blocked' | 'removed'. */
  account_status: string
  status_reason: string | null
  status_changed_at: string | null
  /** Free-text actor, `staff:<uuid>`. */
  status_changed_by: string | null
}

export interface AdminVerificationRow {
  id: string
  user_id: string
  email: string
  full_name: string | null
  id_number: string | null
  status: string
  /** Which documents are on file. The BYTES are deliberately absent — they come
   *  from the audited /api/local/admin/documents endpoint, one explicit request at
   *  a time. This queue used to ship every pending submission's three base64 photos
   *  to anyone who opened the tab, with no record of who saw them. */
  has_front: boolean
  has_back: boolean
  has_selfie: boolean
  submitted_at: string
  reviewed_at: string | null
  reviewed_by: string | null
  notes: string | null
}

export interface AppLinks {
  ios: string | null
  android: string | null
}

export interface AuditEntry {
  id: string
  at: string
  staff_id: string | null
  staff_email: string | null
  action: string
  target_type: string | null
  target_id: string | null
  detail: unknown
  ip: string | null
}

const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'rejected', 'cancelled'] as const

/** Admin drives a reservation's lifecycle (pending → confirmed → completed, or
 *  rejected/cancelled). Issues the reservation code on confirm/complete. */

/** Guest price − host's raw price, for one booking. See bookingCommissionSql(). */
const COMMISSION_AMOUNT_SQL = bookingCommissionSql()

// bookings.total_price stores the host's RAW stay total. This projection exposes
// only the COMMISSION-INCLUSIVE figure, because a booking response is read by the
// guest and the raw price would hand them the platform's margin. A host's payout
// is added explicitly by the host-only readers (see getHostBookings).

/** All open payment disputes (latest proof still 'disputed'), for the admin queue. */
export interface PendingProofRow {
  booking_id: string
  reservation_code: string | null
  title: string | null
  guest_id: string
  guest_name: string | null
  guest_email: string | null
  host_id: string | null
  total_price: number
  amount: number
  method: string | null
  submitted_at: string
  check_in: string
  check_out: string
}

const STAFF_SELECT = `
  SELECT a.id, a.email, a.full_name, a.role, a.is_active, a.last_login_at,
         a.locked_until, a.failed_login_attempts, a.created_at,
         c.email AS created_by_email,
         COALESCE(array_agg(DISTINCT p.module) FILTER (WHERE p.module IS NOT NULL), '{}') AS modules,
         (SELECT count(*)::int FROM staff_sessions s
           WHERE s.staff_id = a.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
    FROM staff_accounts a
    LEFT JOIN staff_accounts c ON c.id = a.created_by
    LEFT JOIN staff_permissions p ON p.staff_id = a.id`
export type StaffAccount = {
  id: string
  email: string
  full_name: string
  role: 'super_admin' | 'moderator'
  is_active: boolean
  last_login_at: string | null
  locked_until: string | null
  failed_login_attempts: number
  created_at: string
  created_by_email: string | null
  modules: string[]
  active_sessions: number
}

/** Thread metadata for the /ops profile — who with, which listing, how many
 *  messages, last activity. Message BODIES are deliberately absent: reading them
 *  goes through adminReadConversation, which the route audits. */
export async function adminListUserConversations(userId: string): Promise<AdminUserConversation[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT c.id, c.listing_id, l.title AS listing_title,
            CASE WHEN c.guest_id = $1 THEN c.host_id ELSE c.guest_id END AS counterparty_id,
            CASE WHEN c.guest_id = $1 THEN hu.full_name ELSE gu.full_name END AS counterparty_name,
            CASE WHEN c.guest_id = $1 THEN hu.email ELSE gu.email END AS counterparty_email,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id)::int AS message_count,
            to_char(c.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_message_at,
            CASE WHEN c.host_id = $1 THEN 'host' ELSE 'guest' END AS viewer_role
       FROM conversations c
       LEFT JOIN listings l ON l.id = c.listing_id
       LEFT JOIN users gu ON gu.id = c.guest_id
       LEFT JOIN users hu ON hu.id = c.host_id
      WHERE c.guest_id = $1 OR c.host_id = $1
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 200`,
    [userId],
  )
  return rows as AdminUserConversation[]
}

export async function getStaffAccount(id: string): Promise<StaffAccount | null> {
  if (!isUuid(id)) return null
  const { rows } = await pool.query<StaffAccount>(
    `${STAFF_SELECT} WHERE a.id = $1 GROUP BY a.id, c.email`,
    [id]
  )
  return rows[0] ?? null
}

// ---- /ops + wishlists, ported from quickin-frontend 21 Aug 2026 ----

/** Partial update of the editable profile fields. Role is intentionally included so
 *  a super admin can promote/demote, but callers must run the last-super-admin guard. */
export async function updateStaffAccount(
  id: string,
  fields: { fullName?: string; role?: 'super_admin' | 'moderator'; isActive?: boolean }
): Promise<StaffAccount | null> {
  if (!isUuid(id)) return null
  const { rowCount } = await pool.query(
    `UPDATE staff_accounts
        SET full_name = COALESCE($2, full_name),
            role      = COALESCE($3, role),
            is_active = COALESCE($4, is_active),
            updated_at = now()
      WHERE id = $1`,
    [id, fields.fullName?.trim().slice(0, 120) ?? null, fields.role ?? null,
     fields.isActive === undefined ? null : fields.isActive]
  )
  if (!rowCount) return null
  return getStaffAccount(id)
}

/** Replace a moderator's module set wholesale (the checkbox grid posts the full list).
 *  Takes effect on the moderator's next request — no re-login needed, since
 *  getStaffFromRequest re-reads permissions every time. */
export async function setStaffModules(id: string, modules: string[], grantedBy: string | null): Promise<void> {
  if (!isUuid(id)) throw new Error('Invalid id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM staff_permissions WHERE staff_id = $1 AND NOT (module = ANY($2::text[]))`, [id, modules])
    if (modules.length) {
      await client.query(
        `INSERT INTO staff_permissions (staff_id, module, granted_by)
         SELECT $1, m, $2 FROM unnest($3::text[]) AS m
         ON CONFLICT (staff_id, module) DO NOTHING`,
        [id, grantedBy && isUuid(grantedBy) ? grantedBy : null, modules]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function deleteStaffAccount(id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const { rowCount } = await pool.query(`DELETE FROM staff_accounts WHERE id = $1`, [id])
  return (rowCount ?? 0) > 0
}

/** How many super admins could still sign in — the last-one-standing guard. */
export async function countActiveSuperAdmins(excludeId?: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff_accounts
      WHERE role = 'super_admin' AND is_active AND ($1::uuid IS NULL OR id <> $1::uuid)`,
    [excludeId ?? null]
  )
  return rows[0]?.n ?? 0
}

/** The user's saved listings (same row shape as getListings, incl. a primary image_url). */
export async function getWishlistListings(userId: string): Promise<Listing[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT ${LISTING_COLS},
            (SELECT url FROM listing_images li WHERE li.listing_id = l.id ORDER BY li."order" LIMIT 1) AS image_url
       FROM saved_listings w JOIN listings l ON l.id = w.listing_id
      WHERE w.user_id = $1
      ORDER BY w.created_at DESC`,
    [userId]
  )
  return rows as Listing[]
}

/** Toggle a listing in the user's wishlist. Insert → {saved:true}; existing → delete → {saved:false}. */
export async function toggleWishlist(userId: string, listingId: string): Promise<{ saved: boolean }> {
  if (!isUuid(userId) || !isUuid(listingId)) throw new Error('Invalid id')
  const del = await pool.query(
    `DELETE FROM saved_listings WHERE user_id = $1 AND listing_id = $2`,
    [userId, listingId]
  )
  if (del.rowCount && del.rowCount > 0) return { saved: false }
  await pool.query(
    `INSERT INTO saved_listings (user_id, listing_id) VALUES ($1, $2)
     ON CONFLICT (user_id, listing_id) DO NOTHING`,
    [userId, listingId]
  )
  return { saved: true }
}