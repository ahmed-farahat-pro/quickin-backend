import { NextResponse } from 'next/server'
import { createServiceRequest, getUserServiceRequests } from '@/lib/local/services'
import { getUserFromRequest } from '@/lib/local/auth'

// Service requests ("subscriptions").
//   GET  /api/local/service-requests → the signed-in user's subscriptions
//   POST /api/local/service-requests { service_id, preferred_date?, note? } → request a service
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
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const requests = await getUserServiceRequests(user.id)
    return NextResponse.json(requests, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load subscriptions', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in to subscribe' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const serviceId = String(b.service_id ?? b.serviceId ?? '')
    if (!serviceId) return NextResponse.json({ error: 'service_id is required' }, { status: 400, headers: CORS })
    const request = await createServiceRequest(user.id, {
      serviceId,
      preferredDate: b.preferred_date ?? b.preferredDate ?? null,
      note: b.note ?? null,
    })
    return NextResponse.json(request, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('POST /api/local/service-requests failed:', msg)
    const status = /already|not found|Invalid|required/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
