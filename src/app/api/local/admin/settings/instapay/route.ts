import { NextResponse } from 'next/server'
import { getPaymentConfig, setSetting } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

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

async function requireAdmin(req: Request) {
  const user = await getUserFromRequest(req)
  if (!user) return { error: NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS }) }
  if (user.role !== 'admin') return { error: NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS }) }
  return { user }
}

export async function GET(req: Request) {
  const gate = await requireAdmin(req)
  if ('error' in gate) return gate.error
  return NextResponse.json(await getPaymentConfig(), { headers: CORS })
}

export async function PUT(req: Request) {
  const gate = await requireAdmin(req)
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body.instapay_handle === 'string') {
      await setSetting('instapay_handle', body.instapay_handle.trim().slice(0, 200), gate.user.id)
    }
    if (typeof body.instructions === 'string') {
      await setSetting('instapay_instructions', body.instructions.trim().slice(0, 2000), gate.user.id)
    }
    return NextResponse.json(await getPaymentConfig(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to save', detail: String(err) }, { status: 500, headers: CORS })
  }
}
