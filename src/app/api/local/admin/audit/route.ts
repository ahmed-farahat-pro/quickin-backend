import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { getAuditLog, getAuditActions } from '@/lib/local/db'
import { ActivityInputError, parseAuditFilter } from '@/lib/local/activity-core'

// GET /api/local/admin/audit?q=&action=&target_type=&from=&to=&limit=&offset=
//   → { entries, hasMore, actions, filter } — the staff audit trail (F2).
//
// Gated on `audit`, which is **super-admin-only**: this log records who opened whose
// identity documents and who read whose private messages, so it is at least as
// sensitive as the things it describes. `actions` is the distinct set actually
// present, so the filter dropdown reflects this deployment rather than a hardcoded
// list that drifts as features are added.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'audit')
  if ('error' in gate) return gate.error
  try {
    const url = new URL(req.url)
    const filter = parseAuditFilter((k) => url.searchParams.get(k))
    const [{ entries, hasMore }, actions] = await Promise.all([
      getAuditLog(filter),
      getAuditActions(),
    ])
    return NextResponse.json({ entries, hasMore, actions, filter }, { headers: CORS })
  } catch (err) {
    if (err instanceof ActivityInputError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    }
    console.error('admin audit GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}
