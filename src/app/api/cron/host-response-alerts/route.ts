import { NextResponse } from 'next/server'
import { runHostResponseSweep } from '@/lib/local/host-response-alerts'

// The nightly host-response sweep: every booking request a host has left pending
// for more than 24h becomes (or stays) an alert in /ops → Host response, and the
// host gets one reminder per night until they accept or decline. Alerts close on
// their own once the host answers or the check-in date passes.
//
//   GET /api/cron/host-response-alerts     header: Authorization: Bearer <CRON_SECRET>
//
// Scheduled at 01:00 UTC by vercel.json = 03:00 Cairo in winter (EET, UTC+2) and
// 04:00 in summer (EEST, UTC+3) — a Vercel cron is fixed UTC and can't follow DST. Safe to run by
// hand and to run repeatedly: a second run the same night opens nothing new and
// nudges no one (NUDGE_MIN_GAP_HOURS).
//
// Same opt-in guard as staff-cleanup: with CRON_SECRET unset this is UNPROTECTED,
// and unlike staff-cleanup it SENDS hosts reminders — set CRON_SECRET in production.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await runHostResponseSweep()
    console.log('host-response sweep:', JSON.stringify(result))
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('host-response-alerts cron:', err)
    return NextResponse.json({ error: 'Sweep failed', detail: String(err) }, { status: 500 })
  }
}
