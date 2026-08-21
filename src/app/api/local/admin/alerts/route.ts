import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { adminStats } from '@/lib/local/db'
import { alertsFor, alertTotal } from '@/lib/local/activity-core'

// GET /api/local/admin/alerts → { alerts, total, oldest } — the alert centre (F4).
//
// Alerts are DERIVED counts over live queues, not stored notifications: there is no
// read/unread state to keep in sync, and an alert disappears exactly when the work is
// done. Filtered server-side to the modules this operator holds — an alert they can't
// act on is noise, and the total shouldn't leak the size of a queue they were never
// granted.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  // 'overview' is the floor for seeing the console at all; each individual alert is
  // then filtered by its own module below.
  const gate = await requireStaff(req, 'overview')
  if ('error' in gate) return gate.error
  try {
    const stats = await adminStats()
    const alerts = alertsFor(stats as unknown as Record<string, number>, {
      modules: gate.staff.modules ?? [],
      isSuperAdmin: gate.staff.role === 'super_admin',
    })
    return NextResponse.json(
      {
        alerts,
        total: alertTotal(alerts),
        oldest: {
          pending_verifications: stats.oldest_verification,
          pending_applications: stats.oldest_application,
          pending_listings: stats.oldest_listing,
          pending_payments: stats.oldest_payment,
          open_reports: stats.oldest_report,
        },
      },
      { headers: CORS },
    )
  } catch (err) {
    console.error('admin alerts GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}
