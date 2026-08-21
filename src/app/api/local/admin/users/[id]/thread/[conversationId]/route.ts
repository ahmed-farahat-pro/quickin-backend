import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { adminReadConversation } from '@/lib/local/db'

// GET /api/local/admin/users/:id/thread/:conversationId
//   → { conversation, messages } — the message BODIES of one thread (D2).
//
// Reading someone's private messages is the most invasive thing this module can do,
// so it is deliberately not part of the profile payload: the operator has to ask for
// a specific thread, and **every call writes a staff_audit_log row**. The /ops UI
// says so above the button, before the first click.
//
// Nested under users/:id rather than a top-level conversations route so the audit
// entry records whose profile the operator was looking at, and so the thread must
// actually belong to that user — adminReadConversation returns null otherwise, which
// stops an operator paging through arbitrary threads by guessing ids.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request, ctx: { params: Promise<{ id: string; conversationId: string }> }) {
  const gate = await requireStaff(req, 'users')
  if ('error' in gate) return gate.error
  const { id, conversationId } = await ctx.params
  try {
    const thread = await adminReadConversation(id, conversationId)
    if (!thread) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404, headers: CORS })
    }
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'user_thread_viewed',
      targetType: 'conversation',
      targetId: conversationId,
      detail: {
        user_id: id,
        counterparty_id: thread.conversation.counterparty_id,
        listing_id: thread.conversation.listing_id,
        message_count: thread.messages.length,
      },
      ip: clientIpOf(req),
    })
    return NextResponse.json(thread, { headers: CORS })
  } catch (err) {
    console.error('admin user thread GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}
