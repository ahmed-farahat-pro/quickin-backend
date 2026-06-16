import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { createReport } from '@/lib/local/trust'

// POST /api/local/reports { target_type, target_id, reason, details? }
// A signed-in user reports a listing / user / review. Staff triage in admin.
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
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in to report' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))
    const result = await createReport(user.id, {
      targetType: b.target_type ?? b.targetType,
      targetId: b.target_id ?? b.targetId,
      reason: b.reason,
      details: b.details,
    })
    return NextResponse.json({ ok: true, ...result }, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to submit report'
    return NextResponse.json({ error: msg }, { status: 400, headers: CORS })
  }
}
