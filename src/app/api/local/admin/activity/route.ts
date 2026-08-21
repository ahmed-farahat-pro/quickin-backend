import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { getActivityFeed } from '@/lib/local/db'
import { ActivityInputError, parseActivityFilter } from '@/lib/local/activity-core'

// GET /api/local/admin/activity?kind=&q=&from=&to=&sort=&limit=&offset=
//   → { events, hasMore, filter } — everything that happened on the site (F1).
//
// The feed is DERIVED from rows that already exist (users, listings, bookings,
// payment_proofs) plus user_logins, so it needs no backfill and can't drift from the
// data it describes. `kind` accepts a comma-separated list.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'overview')
  if ('error' in gate) return gate.error
  try {
    const url = new URL(req.url)
    const filter = parseActivityFilter((k) => url.searchParams.get(k))
    const { events, hasMore } = await getActivityFeed(filter)
    return NextResponse.json({ events, hasMore, filter }, { headers: CORS })
  } catch (err) {
    if (err instanceof ActivityInputError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    console.error('admin activity GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}
