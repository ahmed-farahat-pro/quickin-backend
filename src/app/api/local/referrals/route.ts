import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getReferralSummary, ensureReferralCode } from '@/lib/local/promote'

// GET /api/local/referrals (Bearer) → { code, count, rewardTotal, referred[] }
// The signed-in user's shareable referral code + who they've referred.
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

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.id === 'admin') {
      return NextResponse.json({ code: null, count: 0, rewardTotal: 0, referred: [] }, { headers: CORS })
    }
    await ensureReferralCode(user.id)
    return NextResponse.json(await getReferralSummary(user.id), { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load referrals', detail: String(err) }, { status: 500, headers: CORS })
  }
}
