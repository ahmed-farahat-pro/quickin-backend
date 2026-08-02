import { NextResponse } from 'next/server'
import { getPaymentConfig, setSetting } from '@/lib/local/db'
import { requireStaff, staffActor } from '@/lib/local/staff'

// Admin-controlled Instapay destination.
//   GET /api/local/admin/settings/instapay  → { instapay_handle, instructions }
//   PUT /api/local/admin/settings/instapay {instapay_handle, instructions?}
// Admins only (role='admin').
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
  return NextResponse.json(await getPaymentConfig(), { headers: CORS })
}

export async function PUT(req: Request) {
  const gate = await requireStaff(req, 'payments')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body.instapay_handle === 'string') {
      await setSetting('instapay_handle', body.instapay_handle.trim().slice(0, 200), staffActor(gate.staff))
    }
    if (typeof body.instructions === 'string') {
      await setSetting('instapay_instructions', body.instructions.trim().slice(0, 2000), staffActor(gate.staff))
    }
    return NextResponse.json(await getPaymentConfig(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to save', detail: String(err) }, { status: 500, headers: CORS })
  }
}
