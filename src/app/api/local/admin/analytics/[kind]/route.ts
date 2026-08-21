import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { bookingsReport, revenueReport, cancellationsReport } from '@/lib/local/analytics'
import { parseReportFilter, ReportInputError } from '@/lib/local/analytics-core'
import { REGION_VALUES } from '@/lib/local/resort-core'

// /ops analytics reports (B1, B2, B3). One route, three report kinds — they share
// the whole filter contract, so splitting them would triplicate the query parsing.
//   GET /api/local/admin/analytics/bookings      → totals, trend, by resort, by status
//   GET /api/local/admin/analytics/revenue       → gross, commission, refunds, payouts
//   GET /api/local/admin/analytics/cancellations → count, rate, by actor/policy/resort
//
// Filters (all optional, shared by every kind):
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   default: the last 90 days
//   &region=&resort=<id|__other__|__none__>&host=<uuid>&listing=<uuid>
//   &granularity=day|week|month
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

const REPORTS = {
  bookings: bookingsReport,
  revenue: revenueReport,
  cancellations: cancellationsReport,
} as const

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const gate = await requireStaff(req, 'analytics')
  if ('error' in gate) return gate.error

  const { kind } = await ctx.params
  const report = REPORTS[kind as keyof typeof REPORTS]
  if (!report) {
    return NextResponse.json(
      { error: `Unknown report. Expected one of: ${Object.keys(REPORTS).join(', ')}` },
      { status: 400, headers: CORS }
    )
  }

  try {
    const url = new URL(req.url)
    const filter = parseReportFilter((k) => url.searchParams.get(k), { allowedRegions: REGION_VALUES })
    return NextResponse.json({ filter, ...(await report(filter)) }, { headers: CORS })
  } catch (err) {
    // Bad filter input is the caller's fault, not a server fault.
    if (err instanceof ReportInputError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    console.error(`admin analytics ${kind}:`, err)
    return NextResponse.json(
      { error: 'Failed to build the report', detail: String(err) },
      { status: 500, headers: CORS }
    )
  }
}
