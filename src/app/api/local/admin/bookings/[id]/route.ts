import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminSetBookingStatus } from '@/lib/local/db'

// PATCH /api/local/admin/bookings/:id { status } — admin approve/decline on behalf of host.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'bookings')
  if ('error' in gate) return gate.error
  const { id } = await ctx.params
  const actor = gate.staff.legacy ? null : staffActor(gate.staff)
  try {
    const body = await req.json().catch(() => ({}))
    const status = String(body.status ?? '')
    const result = await adminSetBookingStatus(id, status)
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'booking_status_change',
      targetType: 'booking',
      targetId: id,
      detail: { status, actor },
      ip: clientIpOf(req),
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /Invalid/.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: NO_STORE })
  }
}
