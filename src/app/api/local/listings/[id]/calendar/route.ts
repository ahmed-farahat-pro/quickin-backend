import { NextResponse } from 'next/server'
import {
  getListingCalendar,
  isListingHost,
  updateListingCalendar,
} from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'
import {
  addDays,
  isDatePriceError,
  isIsoDate,
  normalizeDates,
} from '@/lib/local/date-pricing-core'

// A listing's day-by-day calendar — nightly price + availability, in one place.
//
//   GET /api/local/listings/:id/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
//     → { listing_id, currency, commission_rate, base_price, start, end, days: [...] }
//       days[] = { date, price, source, status, guest_price?, note? }
//       `source` is which rung priced the night: custom | weekend | monthly | base
//       `status` is whether the host may edit it: available | blocked | booked
//
//   PUT /api/local/listings/:id/calendar   (the listing's host only)
//     { dates: ["2026-08-16", {start,end}, …], price?: number|null, blocked?: boolean, note?: string }
//       price: number → pin that rate on every selected day
//       price: null   → RESET those days to the listing's default pricing
//       blocked: true/false → close or open those days
//     → { updated, skipped: [{date, reason}], calendar }
//
// GET is PUBLIC but money-aware: the listing's host sees their raw prices (the
// numbers they type) plus `guest_price`; everyone else sees only the
// commission-inclusive figure, and no booking ids or host notes. Same rule as
// the listing projections in db.ts — the reader decides the columns, so no
// route can leak a raw price by forgetting to convert.
export const dynamic = 'force-dynamic'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

/** Today in Cairo. The calendar is a wall-clock artifact: "can I still price
 *  tonight?" must be answered in the host's day, not the server's UTC day. */
function todayInCairo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** Default window: today through three months out — what a calendar UI paints
 *  before the host scrolls. Explicit start/end override it. */
const DEFAULT_WINDOW_DAYS = 92

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const url = new URL(req.url)
    const today = todayInCairo()
    const startParam = url.searchParams.get('start')
    const endParam = url.searchParams.get('end')
    const start = isIsoDate(startParam) ? startParam : today
    const end = isIsoDate(endParam) ? endParam : addDays(start, DEFAULT_WINDOW_DAYS)

    // A signed-in reader who is NOT the host is treated as a guest here on
    // purpose — being logged in does not entitle anyone to another host's
    // raw prices.
    const user = await getUserFromRequest(req).catch(() => null)
    const asHost = await isListingHost(id, user?.id)

    const calendar = await getListingCalendar(id, start, end, { asHost })
    if (!calendar) return NextResponse.json({ error: 'Listing not found' }, { status: 404, headers: CORS })
    return NextResponse.json(calendar, { headers: CORS })
  } catch (err) {
    if (isDatePriceError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    return NextResponse.json(
      { error: 'Failed to load the calendar', detail: String(err) },
      { status: 500, headers: CORS }
    )
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const { id } = await params
    const body = await req.json().catch(() => ({}))

    // normalizeDates throws rather than dropping a bad date: a silently skipped
    // day is one the host believes they priced and did not.
    const dates = normalizeDates(body.dates ?? body.days)

    // `price` and `blocked` are read with `in` rather than truthiness, because
    // `null` (reset) and `false` (unblock) are both meaningful values that a
    // truthiness check would read as "not supplied".
    const change: { price?: number | null; blocked?: boolean; note?: string | null } = {}
    if ('price' in body) change.price = body.price
    if ('blocked' in body) change.blocked = body.blocked === true
    if (typeof body.note === 'string') change.note = body.note.trim() || null

    const result = await updateListingCalendar(id, user.id, dates, change, todayInCairo())
    if (!result) {
      return NextResponse.json(
        { error: 'Only the listing host can edit its calendar' },
        { status: 403, headers: CORS }
      )
    }
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    if (isDatePriceError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS })
  }
}
