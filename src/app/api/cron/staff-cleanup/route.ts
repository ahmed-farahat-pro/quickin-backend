import { NextResponse } from 'next/server'
import { purgeStaffExpired } from '@/lib/local/db'

// Housekeeping for the World-1 (Neon) tables that grow a row per event forever:
// staff_sessions and staff_password_resets (one per staff sign-in / reset request,
// 30 days), and user_logins (one per USER sign-in, 90 days). The last of those is the
// reason this is now scheduled rather than run by hand — it carries an IP and a user
// agent per row, so letting it accumulate indefinitely is a standing privacy
// liability, not just wasted space.
//
//   GET /api/cron/staff-cleanup     header: Authorization: Bearer <CRON_SECRET>
//
// Scheduled daily at 03:00 UTC in vercel.json. Safe to run by hand, and safe to run
// repeatedly.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: Request) {
  // Same guard as the existing cron route: enforced only when CRON_SECRET is set.
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const purged = await purgeStaffExpired()
    return NextResponse.json({ success: true, purged }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('staff-cleanup cron:', err)
    return NextResponse.json({ error: 'Cleanup failed', detail: String(err) }, { status: 500 })
  }
}
