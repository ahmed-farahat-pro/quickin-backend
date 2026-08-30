import { NextResponse } from 'next/server'
import { getServiceById } from '@/lib/local/services'
import { getUserFromRequest } from '@/lib/local/auth'

// GET /api/local/services/:id → one service (public), EXCEPT an unpublished one,
// which 404s for everyone but its own host. A host can now take a service off the
// market (PATCH /api/local/host/services/:id/visibility); that has to mean the
// deep link stops working too, or "removed" would only mean "removed from the
// list". The owner still gets it so their dashboard can show what they hid.
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
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const service = await getServiceById(id)
    if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404, headers: CORS })
    if (!service.is_published) {
      // Only now is it worth resolving the caller — a published service is public
      // and must not pay for an auth round trip.
      const viewer = await getUserFromRequest(req).catch(() => null)
      if (!viewer || viewer.id !== service.host_id) {
        return NextResponse.json({ error: 'Service not found' }, { status: 404, headers: CORS })
      }
      // Its owner gets the host projection: raw price, plus why it is down.
      return NextResponse.json(await getServiceById(id, { asHost: true }), { headers: CORS })
    }
    return NextResponse.json(service, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load service', detail: String(err) }, { status: 500, headers: CORS })
  }
}
