import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { listResorts, createResort, listUnassignedResortNames } from '@/lib/local/resorts'
import { REGION_VALUES } from '@/lib/local/resort-core'

// Resort catalog management (the /ops Resorts module).
//   GET  /api/local/admin/resorts        → { resorts, unassigned, regions }
//   POST /api/local/admin/resorts { name, region } → create one
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'resorts')
  if ('error' in gate) return gate.error
  try {
    const [resorts, unassigned] = await Promise.all([listResorts(), listUnassignedResortNames()])
    return NextResponse.json({ resorts, unassigned, regions: REGION_VALUES }, { headers: NO_STORE })
  } catch (err) {
    console.error('admin resorts GET:', err)
    return NextResponse.json({ error: 'Failed to load resorts', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'resorts')
  if ('error' in gate) return gate.error
  try {
    const b = await req.json().catch(() => ({}))
    const resort = await createResort({
      name: String(b.name ?? ''),
      region: String(b.region ?? ''),
      createdBy: gate.staff.legacy ? null : staffActor(gate.staff),
    })
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'resort_create',
      targetType: 'resort',
      targetId: resort?.id ?? null,
      detail: { name: resort?.name, region: resort?.region },
      ip: clientIpOf(req),
    })
    return NextResponse.json({ resort }, { status: 201, headers: NO_STORE })
  } catch (err) {
    // createResort throws human-readable messages for duplicates and bad input.
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to create' }, { status: 400, headers: NO_STORE })
  }
}
