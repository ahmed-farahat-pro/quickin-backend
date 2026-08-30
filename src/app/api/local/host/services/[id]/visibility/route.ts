import { NextResponse } from 'next/server'
import { hostSetServicePublished } from '@/lib/local/services'
import { getUserFromRequest } from '@/lib/local/auth'

// PATCH /api/local/host/services/:id/visibility  { is_published: boolean }
//
// The services twin of PATCH /api/local/host/listings/:id/visibility — the host
// takes their own service off the market, or puts it back, instead of deleting a
// row that other people's requests point at.
//
// Deactivating flips `is_published` false (the browse list drops it,
// createServiceRequest refuses it) and DECLINES every request still waiting on
// this host; the response says how many. Services have no moderation queue and
// no identity gate, so the host's flag is the only reason one is ever down and a
// reactivate always goes live — hence no `blocked_by` here.
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
      'Access-Control-Allow-Methods': 'PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

/** Same key tolerance as the listings visibility route. */
function readNext(body: Record<string, unknown>): boolean | null {
  for (const key of ['is_published', 'isPublished', 'active', 'published']) {
    const v = body[key]
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 'false') return v === 'true'
  }
  return null
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const next = readNext(body)
    if (next === null) {
      return NextResponse.json(
        { error: 'Send { "is_published": true } to reactivate or { "is_published": false } to deactivate' },
        { status: 400, headers: CORS },
      )
    }

    const result = await hostSetServicePublished(id, user.id, next)
    if (!result) {
      return NextResponse.json(
        { error: 'Only the service host can change this service' },
        { status: 403, headers: CORS },
      )
    }
    return NextResponse.json(result, { headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('PATCH /api/local/host/services/[id]/visibility failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS })
  }
}
