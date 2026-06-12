import { NextResponse } from 'next/server'
import { deleteEntity } from '@/lib/local/admin'
import { getUserFromRequest } from '@/lib/local/auth'

// DELETE /api/local/admin/:entity/:id — admin removes any row.
//   entity ∈ users | listings | bookings | services | service-requests
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
      'Access-Control-Allow-Methods': 'DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function DELETE(req: Request, ctx: { params: Promise<{ entity: string; id: string }> }) {
  try {
    const { entity, id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })
    const result = await deleteEntity(entity, id)
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /Unknown entity|Invalid id/.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
