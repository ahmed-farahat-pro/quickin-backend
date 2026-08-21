import { NextResponse } from 'next/server'
import { requireStaff, staffActor, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { resolveListingResort } from '@/lib/local/resorts'
import { adminListListings, adminSetListingPublished, adminDeleteListing, adminSetListingApproval, isListingInputError } from '@/lib/local/db'

// Admin (staff session + 'listings' module): GET → newest-first listings.
//                    POST { id, action: 'publish'|'unpublish'|'delete'|'approve'|'reject', note? } → mutate.
// On approve, an optional `resort` decides what happens to a free-text resort:
//   { mode: 'new',   name, region? }  → add to the catalog (name may correct a typo)
//   { mode: 'match', resort_id }      → point at an existing resort
//   { mode: 'keep' }                  → leave the host's wording as typed
// Scoped to THIS listing; others sharing the name stay in the /ops Resorts queue.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'listings')
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json({ listings: await adminListListings() }, { headers: CORS })
  } catch (err) {
    console.error('admin listings GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'listings')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => null)
    const id = body?.id
    const action = body?.action
    const ALLOWED = ['publish', 'unpublish', 'delete', 'approve', 'reject']
    if (!id || !ALLOWED.includes(action)) {
      return NextResponse.json({ error: 'id and action required' }, { status: 400, headers: CORS })
    }
    if (action === 'publish') await adminSetListingPublished(id, true)
    else if (action === 'unpublish') await adminSetListingPublished(id, false)
    else if (action === 'approve') {
      // A listing whose resort is free text must have it resolved as part of the
      // approval — the admin either adds it to the catalog (correcting any typo),
      // matches an existing one the host missed, or keeps the wording as typed.
      // Resolve FIRST: if it fails, the listing stays pending rather than going
      // live with an unreviewed resort.
      const resort = body?.resort
      if (resort && typeof resort === 'object') {
        const mode = String(resort.mode ?? '')
        if (!['new', 'match', 'keep'].includes(mode)) {
          return NextResponse.json({ error: "resort.mode must be 'new', 'match' or 'keep'" }, { status: 400, headers: CORS })
        }
        const result = await resolveListingResort({
          listingId: id,
          mode: mode as 'new' | 'match' | 'keep',
          name: resort.name ?? null,
          region: resort.region ?? null,
          resortId: resort.resort_id ?? resort.resortId ?? null,
          actor: gate.staff.legacy ? null : staffActor(gate.staff),
        })
        await logStaffAction({
          staffId: gate.staff.legacy ? null : gate.staff.staffId,
          staffEmail: gate.staff.email,
          action: `resort_${mode === 'keep' ? 'kept' : mode}_at_approval`,
          targetType: 'listing',
          targetId: id,
          detail: { mode, name: resort.name ?? null, aliasRecorded: result.aliasRecorded },
          ip: clientIpOf(req),
        })
      }
      await adminSetListingApproval(id, 'approve', body?.note ?? null)
    }
    else if (action === 'reject') await adminSetListingApproval(id, 'reject', body?.note ?? null)
    else await adminDeleteListing(id)
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('admin listings POST:', err)
    // resolveListingResort throws human-readable input errors; pass them through so
    // the popup can show why the approval was refused.
    const msg = err instanceof Error ? err.message : 'Could not update'
    // isListingInputError covers the typed throws (the host-verification gate,
    // the listing validators); the regex covers the older message-only ones.
    const isInput = isListingInputError(err) || /required|Pick a|Invalid|no longer exists|no usable/.test(msg)
    return NextResponse.json({ error: isInput ? msg : 'Could not update' }, { status: isInput ? 400 : 500, headers: CORS })
  }
}
