import { NextResponse } from 'next/server'
import { getPaymentConfig, setSetting } from '@/lib/local/db'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import {
  INSTAPAY_KEYS,
  isPaymentConfigError,
  normalizeHandle,
  normalizeInstapayLink,
  normalizeInstructions,
  normalizeQrImage,
} from '@/lib/local/payment-config-core'

// Admin-controlled Instapay destination (World 1 — cookie auth, non-Supabase).
//   GET /api/local/admin/settings/instapay
//     → { instapay_handle, instructions, instapay_link, instapay_qr_image, qr_payload }
//   PUT /api/local/admin/settings/instapay
//     {instapay_handle?, instructions?, instapay_link?, instapay_qr_image?}
// Every field is optional — an omitted key is left untouched, an empty string
// clears it. Requires a staff session with the 'payments' module.
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
    const actor = staffActor(gate.staff)

    // Validate everything before writing anything, so a bad QR can't leave a
    // half-saved config behind.
    const updates: Array<[string, string]> = []
    if (typeof body.instapay_handle === 'string') {
      updates.push([INSTAPAY_KEYS.handle, normalizeHandle(body.instapay_handle)])
    }
    if (typeof body.instructions === 'string') {
      updates.push([INSTAPAY_KEYS.instructions, normalizeInstructions(body.instructions)])
    }
    if (typeof body.instapay_link === 'string') {
      updates.push([INSTAPAY_KEYS.link, normalizeInstapayLink(body.instapay_link)])
    }
    if (typeof body.instapay_qr_image === 'string') {
      updates.push([INSTAPAY_KEYS.qr, normalizeQrImage(body.instapay_qr_image)])
    }

    for (const [key, value] of updates) await setSetting(key, value, actor)
    // This changes the account guests are told to pay. It was previously the single
    // most consequential unaudited action in the system.
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'instapay_updated',
      targetType: 'setting',
      targetId: 'instapay',
      detail: { fields: updates.map(([k]) => k) },
      ip: clientIpOf(req),
    })
    return NextResponse.json(await getPaymentConfig(), { headers: CORS })
  } catch (err) {
    if (isPaymentConfigError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    return NextResponse.json({ error: 'Failed to save', detail: String(err) }, { status: 500, headers: CORS })
  }
}
