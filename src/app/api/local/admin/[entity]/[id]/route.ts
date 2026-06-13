import { NextResponse } from 'next/server'
import { deleteEntity, updateUserRole, adminSetBookingStatus } from '@/lib/local/admin'
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
      'Access-Control-Allow-Methods': 'DELETE,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

// Change a user's role: PATCH /api/local/admin/users/:id { role: 'user'|'host'|'admin' }
export async function PATCH(req: Request, ctx: { params: Promise<{ entity: string; id: string }> }) {
  try {
    const { entity, id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403, headers: CORS })
    const body = await req.json().catch(() => ({}))
    // Reservation lifecycle: PATCH /api/local/admin/bookings/:id { status }
    if (entity === 'bookings') {
      const result = await adminSetBookingStatus(id, String(body.status ?? ''))
      return NextResponse.json(result, { headers: CORS })
    }
    if (entity !== 'users') {
      return NextResponse.json({ error: 'Only users and bookings can be updated' }, { status: 400, headers: CORS })
    }
    const role = String(body.role ?? '')
    if (!['user', 'host', 'admin'].includes(role)) {
      return NextResponse.json({ error: 'role must be user, host, or admin' }, { status: 400, headers: CORS })
    }
    const result = await updateUserRole(id, role)
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: /Invalid/.test(msg) ? 400 : 500, headers: CORS })
  }
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
