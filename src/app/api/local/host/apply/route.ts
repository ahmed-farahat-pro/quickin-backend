import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getHostState, submitHostApplication, HOST_TYPES, type HostType } from '@/lib/local/db'

// POST /api/local/host/apply — submit (or re-submit after a rejection) a host
// application for admin review. It NEVER grants hosting: only an admin approval in
// /api/local/admin/host-applications flips users.is_host.
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

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export async function POST(req: Request) {
  try {
    const me = await getUserFromRequest(req)
    if (!me || me.id === 'admin') {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    }
    const b = await req.json().catch(() => ({}))
    const fullName = str(b.full_name ?? b.fullName)
    const nationalId = str(b.national_id ?? b.nationalId)
    const phone = str(b.phone)
    const address = str(b.address)
    const hostType = str(b.host_type ?? b.hostType).toLowerCase()
    const company = str(b.company)
    const notes = str(b.notes)

    // Per-field messages so the clients can highlight the offending input
    // (same copy as the web's submitHostApplication). Only company + notes are optional.
    const fields: Record<string, string> = {}
    if (!fullName) fields.full_name = 'Full name is required'
    if (!nationalId) fields.national_id = 'National ID is required'
    if (!phone) fields.phone = 'Phone is required'
    if (!address) fields.address = 'Address is required'
    if (!(HOST_TYPES as readonly string[]).includes(hostType)) fields.host_type = 'Choose individual, company or brokerage'
    if (Object.keys(fields).length) {
      return NextResponse.json({ error: 'Please check the highlighted fields', fields }, { status: 400, headers: CORS })
    }

    // Existing hosts don't apply, and a pending application can't be replaced.
    const state = await getHostState(me.id)
    if (state.is_host) {
      return NextResponse.json({ error: 'Already a host' }, { status: 409, headers: CORS })
    }
    if (state.host_status === 'pending') {
      return NextResponse.json({ error: 'Application already under review' }, { status: 409, headers: CORS })
    }

    const application = await submitHostApplication(me.id, {
      full_name: fullName,
      national_id: nationalId,
      phone,
      address,
      host_type: hostType as HostType,
      company: company || null,
      notes: notes || null,
    })
    return NextResponse.json({ ok: true, host_status: 'pending', application }, { headers: CORS })
  } catch (err) {
    console.error('host apply failed:', err)
    return NextResponse.json({ error: 'Could not submit application', detail: String(err) }, { status: 500, headers: CORS })
  }
}
