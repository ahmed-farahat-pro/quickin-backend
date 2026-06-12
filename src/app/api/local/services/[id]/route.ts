import { NextResponse } from 'next/server'
import { getServiceById } from '@/lib/local/services'

// GET /api/local/services/:id → one service (public).
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

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const service = await getServiceById(id)
    if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404, headers: CORS })
    return NextResponse.json(service, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load service', detail: String(err) }, { status: 500, headers: CORS })
  }
}
