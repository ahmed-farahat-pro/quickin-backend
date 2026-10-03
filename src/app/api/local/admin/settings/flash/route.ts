import { NextResponse } from 'next/server'
import { getPaymentConfig, setSetting } from '@/lib/local/db'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { FLASH_KEYS, boolToStored } from '@/lib/local/payment-config-core'

// Admin switch for FLASH, the automatic card/wallet method (World 1 — cookie auth).
//   GET /api/local/admin/settings/flash → the whole payment config, like the
//       Instapay and bank routes; `flash: {enabled, configured}` is this method.
//   PUT /api/local/admin/settings/flash {enabled: boolean}
//
// There is nothing else to edit: the credentials are FLASH_* env vars, so
// `configured` reports whether the server has them. Turning it on without them
// is allowed (it just stays out of available_methods) so the toggle can be set
// ahead of a deploy. Requires a staff session with the 'payments' module.
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

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'payments')
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json(await getPaymentConfig(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function PUT(req: Request) {
  const gate = await requireStaff(req, 'payments')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: '`enabled` must be true or false' }, { status: 400, headers: CORS })
    }
    await setSetting(FLASH_KEYS.enabled, boolToStored(body.enabled), staffActor(gate.staff))
    // Turning on a method that charges cards is money-moving config — audited
    // like the other two destinations.
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'flash_updated',
      targetType: 'setting',
      targetId: 'flash',
      detail: { enabled: body.enabled },
      ip: clientIpOf(req),
    })
    return NextResponse.json(await getPaymentConfig(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to save', detail: String(err) }, { status: 500, headers: CORS })
  }
}
