import { NextResponse } from 'next/server'
import { getServiceRequestById, setServiceRequestStatus } from '@/lib/local/services'
import { getUserFromRequest } from '@/lib/local/auth'

// Single service request ("subscription").
//   GET   /api/local/service-requests/:id           → details (requester OR the service's host)
//   PATCH /api/local/service-requests/:id {status}  → host confirms/rejects a pending request
//      status: "confirm" | "reject" (or "confirmed" | "rejected")
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
      'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const request = await getServiceRequestById(id)
    if (!request) return NextResponse.json({ error: 'Request not found' }, { status: 404, headers: CORS })
    if (request.user_id !== user.id && request.host_id !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403, headers: CORS })
    }
    return NextResponse.json(request, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load request', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const body = await req.json().catch(() => ({}))
    const action = String(body.status ?? body.action ?? '')
    const status = /^confirm/i.test(action) ? 'confirmed' : /^reject/i.test(action) ? 'rejected' : null
    if (!status) {
      return NextResponse.json({ error: 'status must be "confirm" or "reject"' }, { status: 400, headers: CORS })
    }
    const updated = await setServiceRequestStatus(id, user.id, status)
    if (!updated) {
      return NextResponse.json(
        { error: 'Not allowed — you must be the host of this service and the request must still be pending.' },
        { status: 403, headers: CORS }
      )
    }
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update request', detail: String(err) }, { status: 500, headers: CORS })
  }
}
