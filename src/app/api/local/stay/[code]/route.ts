import { NextResponse } from 'next/server'
import { getStayByCode } from '@/lib/local/db'

// GET /api/local/stay/:code — PUBLIC stay "pass" data, looked up by the
// reservation code embedded in the QR. No auth (so a scan/click works for
// anyone holding the code) and only non-sensitive fields are returned: the
// place, city/region, dates, guest first name, host name, and the host's notes.
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

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await ctx.params
    const stay = await getStayByCode(code)
    if (!stay) return NextResponse.json({ error: 'Stay not found' }, { status: 404, headers: CORS })
    return NextResponse.json(stay, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load stay', detail: String(err) }, { status: 500, headers: CORS })
  }
}
