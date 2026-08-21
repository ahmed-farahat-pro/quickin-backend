import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { updateResort, assignFreeTextToResort } from '@/lib/local/resorts'

// One resort.
//   PATCH /api/local/admin/resorts/:id { name?, region?, is_active? }
//   PATCH /api/local/admin/resorts/:id { assign_name }  → sweep free-text listings in
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'resorts')
  if ('error' in gate) return gate.error
  const { id } = await ctx.params
  const actor = gate.staff.legacy ? null : staffActor(gate.staff)
  try {
    const b = await req.json().catch(() => ({}))

    // Sweep: attach an existing free-text name to this resort.
    if (typeof b.assign_name === 'string') {
      const relinked = await assignFreeTextToResort(b.assign_name, id, actor)
      await logStaffAction({
        staffId: gate.staff.legacy ? null : gate.staff.staffId,
        staffEmail: gate.staff.email,
        action: 'resort_assign',
        targetType: 'resort',
        targetId: id,
        detail: { name: b.assign_name, listingsRelinked: relinked },
        ip: clientIpOf(req),
      })
      return NextResponse.json({ ok: true, listingsRelinked: relinked }, { headers: NO_STORE })
    }

    const resort = await updateResort(
      id,
      {
        name: b.name === undefined ? undefined : String(b.name),
        region: b.region === undefined ? undefined : String(b.region),
        isActive: b.is_active === undefined ? undefined : Boolean(b.is_active),
      },
      actor
    )
    if (!resort) return NextResponse.json({ error: 'Resort not found' }, { status: 404, headers: NO_STORE })
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'resort_update',
      targetType: 'resort',
      targetId: id,
      detail: { name: b.name, region: b.region, is_active: b.is_active },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ resort }, { headers: NO_STORE })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to update' }, { status: 400, headers: NO_STORE })
  }
}
