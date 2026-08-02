import { NextResponse } from 'next/server'
import { deleteEntity, updateUserRole, adminSetBookingStatus, adminSetListingPublished } from '@/lib/local/admin'
import { requireStaff, type StaffModule } from '@/lib/local/staff'

// DELETE /api/local/admin/:entity/:id — admin removes any row.
//   entity ∈ users | listings | bookings | services | service-requests
export const dynamic = 'force-dynamic'

// Which staff module owns each entity. Unlike every other admin route, the
// permission here depends on the path parameter, so the gate can only run after
// `await ctx.params` — and an unrecognised entity must be rejected BEFORE the gate,
// or a typo would be checked against the wrong permission.
// services / service-requests have no /ops module of their own yet; they're gated by
// their nearest owner (a service is a host listing, a request is a booking).
const ENTITY_MODULE: Record<string, StaffModule> = {
  users: 'users',
  listings: 'listings',
  bookings: 'bookings',
  services: 'listings',
  'service-requests': 'bookings',
}
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
    const permission = ENTITY_MODULE[entity]
    if (!permission) {
      return NextResponse.json({ error: 'Unknown entity' }, { status: 400, headers: CORS })
    }
    const gate = await requireStaff(req, permission)
    if ('error' in gate) return gate.error
    const body = await req.json().catch(() => ({}))
    // Reservation lifecycle: PATCH /api/local/admin/bookings/:id { status }
    if (entity === 'bookings') {
      const result = await adminSetBookingStatus(id, String(body.status ?? ''))
      return NextResponse.json(result, { headers: CORS })
    }
    // Listing active/inactive: PATCH /api/local/admin/listings/:id { is_published }
    if (entity === 'listings') {
      const isPublished = body.is_published ?? body.active
      const result = await adminSetListingPublished(id, Boolean(isPublished))
      return NextResponse.json(result, { headers: CORS })
    }
    if (entity !== 'users') {
      return NextResponse.json({ error: 'Only users, listings and bookings can be updated' }, { status: 400, headers: CORS })
    }
    const role = String(body.role ?? '')
    if (!['user', 'host', 'admin'].includes(role)) {
      return NextResponse.json({ error: 'role must be user, host, or admin' }, { status: 400, headers: CORS })
    }
    // Escalation guard: while the legacy compat fallback is enabled, a `users` row
    // with role='admin' still satisfies an admin gate — so handing out that role is
    // equivalent to handing out super admin. A moderator holding only the 'users'
    // module must not be able to promote themselves (or an accomplice) that way.
    if (role === 'admin' && gate.staff.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Only a super admin can grant the admin role' },
        { status: 403, headers: CORS }
      )
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
    const permission = ENTITY_MODULE[entity]
    if (!permission) {
      return NextResponse.json({ error: 'Unknown entity' }, { status: 400, headers: CORS })
    }
    const gate = await requireStaff(req, permission)
    if ('error' in gate) return gate.error
    const result = await deleteEntity(entity, id)
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /Unknown entity|Invalid id/.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
