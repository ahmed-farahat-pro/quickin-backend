import { NextResponse } from 'next/server'
import { getStayByCode, normalizeStayCode } from '@/lib/local/db'

// GET /api/local/stay/:code — PUBLIC stay "pass" data, looked up by the
// reservation code embedded in the QR. No auth (so a scan/click works for
// anyone holding the code) and only non-sensitive fields are returned: the
// place, city/region, dates, guest first name, host name, the host's notes and
// the host-authored `guide` items.
//
// A code only exists once a booking is CONFIRMED — a pending reservation has
// reservation_code NULL and no QR at all. A missing/"null" segment therefore
// isn't a lookup failure but a client that built a link it shouldn't have:
// answer 400 `missing_code` so the page can say "no reservation code yet"
// instead of "we couldn't find that reservation".
//
// A code alone is NOT the pass. Host approval mints the code while the booking is
// still unpaid, so the payload carries `is_live` (confirmed AND paid, or
// completed) and the host's stay guide is empty unless it is true. Render on
// `is_live`, never on `status` alone.
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
    if (!normalizeStayCode(code)) {
      return NextResponse.json(
        { error: 'No reservation code', reason: 'missing_code' },
        { status: 400, headers: CORS }
      )
    }
    const stay = await getStayByCode(code)
    if (!stay) {
      return NextResponse.json(
        { error: 'Stay not found', reason: 'unknown_code' },
        { status: 404, headers: CORS }
      )
    }
    return NextResponse.json(stay, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load stay', detail: String(err) }, { status: 500, headers: CORS })
  }
}
