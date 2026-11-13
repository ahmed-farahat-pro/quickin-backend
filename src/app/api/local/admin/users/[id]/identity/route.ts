import { NextResponse } from 'next/server'
import { requireStaff, clientIpOf } from '@/lib/local/staff'
import { adminGetGuestIdentity, adminRevealGuestIdentity, recordIdentityReveal } from '@/lib/local/guest-identity'

// GET  /api/local/admin/users/:id/identity
//   → the MASKED identity panel: phone and ID number masked to their last three
//     characters, document type, verification state, and the list of uploaded files
//     (references only — the bytes come from /api/local/admin/documents, audited).
//     The same object rides on GET /admin/users/:id as `identity`.
//
// POST /api/local/admin/users/:id/identity
//   → { phone, id_number, id_number_source, doc_type } — the FULL values, after an
//     `identity_revealed` row is written to staff_audit_log. The write is awaited and
//     allowed to fail the request: an unlogged reveal is the thing masking exists to
//     prevent. POST rather than GET so nothing prefetches or caches it.
//
// Both need the `users` module, the same as the profile itself.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store, private' }

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'users')
  if ('error' in gate) return gate.error
  const { id } = await ctx.params
  try {
    const identity = await adminGetGuestIdentity(id)
    if (!identity) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: CORS })
    return NextResponse.json(identity, { headers: CORS })
  } catch (err) {
    console.error('admin user identity GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireStaff(req, 'users')
  if ('error' in gate) return gate.error
  const { id } = await ctx.params
  try {
    const secrets = await adminRevealGuestIdentity(id)
    if (!secrets) return NextResponse.json({ error: 'User not found' }, { status: 404, headers: CORS })
    // Not logStaffAction, which is best-effort: if this row cannot be written the
    // values are not sent.
    await recordIdentityReveal({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      userId: id,
      detail: { phone: !!secrets.phone, id_number: !!secrets.id_number, id_number_source: secrets.id_number_source },
      ip: clientIpOf(req),
    })
    return NextResponse.json(secrets, { headers: CORS })
  } catch (err) {
    console.error('admin user identity POST:', err)
    return NextResponse.json({ error: 'Could not reveal' }, { status: 500, headers: CORS })
  }
}
