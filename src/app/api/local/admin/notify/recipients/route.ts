import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { searchNotifyRecipients } from '@/lib/local/admin'

// GET /api/local/admin/notify/recipients?q= (staff 'notify') — the /ops Notifications
// recipient picker. Up to 20 active accounts whose name, email, phone or id matches
// (q needs 2+ characters), each with `device_count` = registered push devices.
export const dynamic = 'force-dynamic'
const HEADERS = { 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  try {
    const gate = await requireStaff(req, 'notify')
    if ('error' in gate) return gate.error
    const q = new URL(req.url).searchParams.get('q')
    const users = await searchNotifyRecipients(q)
    return NextResponse.json({ users }, { headers: HEADERS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500, headers: HEADERS })
  }
}
