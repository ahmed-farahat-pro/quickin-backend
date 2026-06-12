import { NextResponse } from 'next/server'
import { getServices, createService } from '@/lib/local/services'
import { getUserFromRequest } from '@/lib/local/auth'

// Services — standalone experiences a host offers (jet ski, diving, tours…).
//   GET  /api/local/services → all published services (browse)
//   POST /api/local/services → a host (or admin) posts a service
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

export async function GET() {
  try {
    const services = await getServices()
    return NextResponse.json(services, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/services failed:', err)
    return NextResponse.json({ error: 'Failed to load services', detail: String(err) }, { status: 500, headers: CORS })
  }
}

// A host posts a service. Requires a signed-in user with role 'host' (or 'admin').
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    if (user.role !== 'host' && user.role !== 'admin') {
      return NextResponse.json({ error: 'Only hosts can post a service. Register as a host first.' }, { status: 403, headers: CORS })
    }
    const b = await req.json()
    const service = await createService(user.id, {
      title: b.title,
      description: b.description,
      category: b.category,
      location: b.location,
      price: Number(b.price ?? 0),
      imageUrl: b.image_url ?? b.imageUrl,
      lat: b.lat,
      lng: b.lng,
    })
    return NextResponse.json(service, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('POST /api/local/services failed:', msg)
    const status = /required|negative|Invalid/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
