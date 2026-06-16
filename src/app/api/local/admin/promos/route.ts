import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { listPromos, createPromo, setPromoActive, deletePromo } from '@/lib/local/promote'

// Admin promo-code management.
//   GET    /api/local/admin/promos                                  → all codes
//   POST   /api/local/admin/promos { code, kind, value, ... }       → create/update a code
//   POST   /api/local/admin/promos { id, action: "toggle", active } → enable/disable
//   DELETE /api/local/admin/promos?id=...                           → delete a code
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
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
  if (gate.error) return gate.error
  try {
    return NextResponse.json(await listPromos(), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load promos', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireAdmin(req)
  if (gate.error) return gate.error
  try {
    const b = await req.json().catch(() => ({}))
    if (b.action === 'toggle' && b.id) {
      const ok = await setPromoActive(String(b.id), Boolean(b.active))
      if (!ok) return NextResponse.json({ error: 'Code not found' }, { status: 404, headers: CORS })
      return NextResponse.json({ ok: true, active: Boolean(b.active) }, { headers: CORS })
    }
    const promo = await createPromo({
      code: b.code,
      kind: b.kind,
      value: Number(b.value),
      maxRedemptions: b.max_redemptions ?? b.maxRedemptions ?? null,
      expiresAt: b.expires_at ?? b.expiresAt ?? null,
    })
    return NextResponse.json(promo, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save promo'
    return NextResponse.json({ error: msg }, { status: 400, headers: CORS })
  }
}

export async function DELETE(req: Request) {
  const gate = await requireAdmin(req)
  if (gate.error) return gate.error
  try {
    const id = new URL(req.url).searchParams.get('id') ?? ''
    const ok = await deletePromo(id)
    if (!ok) return NextResponse.json({ error: 'Code not found' }, { status: 404, headers: CORS })
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to delete promo', detail: String(err) }, { status: 500, headers: CORS })
  }
}
