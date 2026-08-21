import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf, staffActor } from '@/lib/local/staff'
import { reportRows } from '@/lib/local/analytics'
import { parseReportFilter, toCsv, ReportInputError, type DateColumn } from '@/lib/local/analytics-core'
import { REGION_VALUES } from '@/lib/local/resort-core'
import { toXlsx, attachmentName } from '@/lib/local/xlsx'

// B4 — export any report as CSV or Excel.
//   GET /api/local/admin/analytics/export?kind=bookings|revenue|cancellations
//                                        &format=csv|xlsx
//                                        &<the same filters the reports take>
//
// Takes the IDENTICAL filter querystring as the report routes, so an export always
// reconciles with what the operator was looking at. `kind` only chooses which date
// axis the rows are filtered on — the row shape is the same either way, since one
// booking-level table answers all three reports.
//
// runtime = 'nodejs' is required: the xlsx writer is not edge-compatible.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** Which date column each report is "about". Filtering cancellations by created_at
 *  would silently include bookings that were never cancelled. */
const DATE_AXIS: Record<string, DateColumn> = {
  bookings: 'created_at',
  revenue: 'money_at',
  cancellations: 'cancelled_at',
}

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'analytics')
  if ('error' in gate) return gate.error

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind') ?? 'bookings'
  const format = url.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv'
  const axis = DATE_AXIS[kind]
  if (!axis) {
    return NextResponse.json(
      { error: `Unknown report. Expected one of: ${Object.keys(DATE_AXIS).join(', ')}` },
      { status: 400, headers: NO_STORE }
    )
  }

  try {
    const filter = parseReportFilter((k) => url.searchParams.get(k), { allowedRegions: REGION_VALUES })
    const { headers, rows } = await reportRows(filter, axis)

    // An export can carry every guest and host email in the window, so it is worth
    // recording who took one and over what range.
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'analytics_export',
      detail: { kind, format, rows: rows.length, from: filter.from, to: filter.to },
      ip: clientIpOf(req),
    })

    const filename = attachmentName(`quickin-${kind}-${filter.from}-to-${filter.to}`, format)

    if (format === 'xlsx') {
      const buf = await toXlsx(headers, rows as never, { sheetName: kind })
      return new Response(new Uint8Array(buf), {
        headers: {
          ...NO_STORE,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    }

    // charset=utf-8 plus the BOM toCsv writes: together these are what make Excel
    // on Windows read Arabic listing names instead of mojibake.
    return new Response(toCsv(headers, rows), {
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    if (err instanceof ReportInputError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: NO_STORE })
    }
    console.error('admin analytics export:', err)
    return NextResponse.json(
      { error: 'Failed to build the export', detail: String(err) },
      { status: 500, headers: NO_STORE }
    )
  }
}
