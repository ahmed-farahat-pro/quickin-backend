import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminBroadcast } from '@/lib/local/admin'
import { parseNotifyRequest, NotifyInputError } from '@/lib/local/notify-core'

// POST /api/local/admin/notify (staff 'notify') — fire a notification to users.
//   { title, body?, link?, audience?: 'all'|'guests'|'hosts', user_ids?: uuid[], push?, email? }
// user_ids (1–200) targets those users and wins over audience.
// → in-app notification for each + FCM push (+ optional email).
// Returns { recipients, emailed, with_device, skipped }.
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
    const gate = await requireStaff(req, 'notify')
    if ('error' in gate) return gate.error
    const b = await req.json().catch(() => ({}))
    const parsed = parseNotifyRequest(b)
    const result = await adminBroadcast(parsed)
    const t = parsed.target
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'broadcast_sent',
      targetType: 'setting',
      targetId: 'broadcast',
      detail: {
        audience: t.kind === 'audience' ? t.audience : 'users',
        user_ids: t.kind === 'users' ? t.userIds : undefined,
        title: parsed.title,
        push: parsed.push,
        email: parsed.email,
        recipients: result.recipients,
      },
      ip: clientIpOf(req),
    })
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: err instanceof NotifyInputError ? 400 : 500, headers: CORS })
  }
}
