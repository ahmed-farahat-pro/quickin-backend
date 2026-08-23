import { NextResponse } from 'next/server'
import { getPaymentConfig, setSetting } from '@/lib/local/db'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import {
  BANK_KEYS,
  boolToStored,
  isPaymentConfigError,
  normalizeAccountName,
  normalizeAccountNumber,
  normalizeBankIban,
  normalizeBankName,
  normalizeInstructions,
} from '@/lib/local/payment-config-core'

// Admin-controlled BANK TRANSFER destination (World 1 — cookie auth), the second
// way a guest can pay alongside Instapay.
//   GET /api/local/admin/settings/bank
//     → the whole payment config (both methods), same payload as the Instapay route
//   PUT /api/local/admin/settings/bank
//     {enabled?, bank_name?, account_name?, account_number?, iban?, instructions?}
//
// Every field is optional — an omitted key is left untouched, an empty string
// clears it. Requires a staff session with the 'payments' module.
//
// Why GET returns everything rather than just the bank block: /ops/payments draws
// both panels from one server-side load, and two shapes for one settings screen
// would only invite them to disagree about which method is available.
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

    // Validate everything before writing anything, so a bad IBAN can't leave the
    // account number saved against the old bank — a half-written destination is
    // worse than none, because it looks complete to a guest.
    const updates: Array<[string, string]> = []
    if (typeof body.enabled === 'boolean') {
      updates.push([BANK_KEYS.enabled, boolToStored(body.enabled)])
    }
    if (typeof body.bank_name === 'string') {
      updates.push([BANK_KEYS.bankName, normalizeBankName(body.bank_name)])
    }
    if (typeof body.account_name === 'string') {
      updates.push([BANK_KEYS.accountName, normalizeAccountName(body.account_name)])
    }
    if (typeof body.account_number === 'string') {
      updates.push([BANK_KEYS.accountNumber, normalizeAccountNumber(body.account_number)])
    }
    if (typeof body.iban === 'string') {
      updates.push([BANK_KEYS.iban, normalizeBankIban(body.iban)])
    }
    if (typeof body.instructions === 'string') {
      updates.push([BANK_KEYS.instructions, normalizeInstructions(body.instructions)])
    }

    for (const [key, value] of updates) await setSetting(key, value, actor)
    // This changes the account guests are told to pay. Audited for the same reason
    // the Instapay destination is: it is money-moving config, and knowing WHEN it
    // changed is what makes a misdirected transfer traceable.
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'bank_transfer_updated',
      targetType: 'setting',
      targetId: 'bank_transfer',
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
