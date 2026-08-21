import { NextResponse } from 'next/server'
import { getCommissionConfig, getCommissionImpact, setCommissionRate } from '@/lib/local/db'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { isCommissionError, rateFromPercent } from '@/lib/local/commission-core'

// The platform commission — the percentage added on top of every host's raw
// price to produce the price a guest sees and pays.
//   GET /api/local/admin/settings/commission
//     → { rate, percent, updated_at, updated_by, impact: { listings, services } }
//   PUT /api/local/admin/settings/commission  { percent }   (e.g. 12.5)
//
// Changing this REPRICES every listing and service immediately, because guest
// prices are derived at read time. It does NOT touch bookings that already
// exist: each one snapshots the rate it was taken at (bookings.commission_rate).
// Requires a staff session with the 'pricing' module.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'pricing')
  if ('error' in gate) return gate.error
  const [config, impact] = await Promise.all([getCommissionConfig(), getCommissionImpact()])
  return NextResponse.json({ ...config, impact }, { headers: CORS })
}

export async function PUT(req: Request) {
  const gate = await requireStaff(req, 'pricing')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => ({}))
    // Validate before writing — a rejected value must leave the old rate in place.
    const rate = rateFromPercent(body.percent ?? body.rate_percent)
    const previous = await getCommissionConfig()
    const config = await setCommissionRate(rate, staffActor(gate.staff))
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'commission_rate_updated',
      targetType: 'setting',
      targetId: 'platform_commission_rate',
      // Both values, because this one setting moves every price on the platform.
      detail: { from_percent: previous.percent, to_percent: config.percent },
      ip: clientIpOf(req),
    })
    const impact = await getCommissionImpact()
    return NextResponse.json({ ...config, impact }, { headers: CORS })
  } catch (err) {
    if (isCommissionError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    return NextResponse.json({ error: 'Failed to save', detail: String(err) }, { status: 500, headers: CORS })
  }
}
