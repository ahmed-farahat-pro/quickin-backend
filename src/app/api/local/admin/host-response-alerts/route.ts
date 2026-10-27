import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf, staffActor } from '@/lib/local/staff'
import {
  adminGetHostResponseAlert,
  adminListHostResponseAlerts,
  markHostResponseAlertHandled,
} from '@/lib/local/host-response-alerts'
import {
  HostAlertInputError,
  normalizeHandledNote,
  normalizeListFilter,
} from '@/lib/local/host-response-alerts-core'

// Host response alerts — the /ops queue of booking requests hosts left unanswered
// for 24h+ (written nightly by /api/cron/host-response-alerts).
//   GET  /api/local/admin/host-response-alerts?status=open|handled|closed|all
//   POST /api/local/admin/host-response-alerts { id, note }   → open → handled
//
// Marking handled records what staff did ("called the host"); it does not touch the
// booking. The host still decides — or staff use /ops → Booking Requests.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'bookings')
  if ('error' in gate) return gate.error
  try {
    const status = normalizeListFilter(new URL(req.url).searchParams.get('status'))
    return NextResponse.json({ alerts: await adminListHostResponseAlerts(status), status }, { headers: CORS })
  } catch (err) {
    console.error('admin host-response-alerts GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'bookings')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const id = String(body?.id ?? '')
    let note: string
    try {
      note = normalizeHandledNote(body?.note)
    } catch (e) {
      if (e instanceof HostAlertInputError) {
        return NextResponse.json({ error: e.message }, { status: 400, headers: CORS })
      }
      throw e
    }
    const current = await adminGetHostResponseAlert(id)
    if (!current) return NextResponse.json({ error: 'Alert not found' }, { status: 404, headers: CORS })

    const ok = await markHostResponseAlertHandled({
      id,
      note,
      actor: staffActor(gate.staff),
      actorName: gate.staff.fullName || gate.staff.email,
    })
    if (!ok) {
      // Handled by someone else, or the host answered and the sweep closed it.
      return NextResponse.json(
        { error: 'This alert is no longer open — refresh to see its current state' },
        { status: 409, headers: CORS },
      )
    }

    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'host_response_alert_handled',
      targetType: 'booking',
      targetId: current.booking_id,
      detail: { alertId: id, hostId: current.host_id },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ ok: true, alert: await adminGetHostResponseAlert(id) }, { headers: CORS })
  } catch (err) {
    console.error('admin host-response-alerts POST:', err)
    return NextResponse.json({ error: 'Action failed' }, { status: 500, headers: CORS })
  }
}
