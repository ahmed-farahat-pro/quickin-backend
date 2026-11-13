import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { getApplicantProfile, getHostApplication, getHostState, getPayoutMethod } from '@/lib/local/db'
import { HOST_TERMS_VERSION } from '@/lib/local/host-application-core'

// GET /api/local/host/application — the signed-in user's host application.
//   → { host_status: 'none'|'pending'|'rejected'|'approved', application: {…}|null,
//       profile: { full_name, phone, national_id, doc_type, verification_status, missing[] },
//       payout_method: {…}|null, terms_version }
// `profile` is what the form shows read-only ("From your profile"); `missing`
// lists the only profile fields it should ask for. See host-application-core.
// host_status is derived (users.is_host wins, so legacy hosts read as approved).
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
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const me = await getUserFromRequest(req)
    if (!me || me.id === 'admin') {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    }
    const [state, application, applicant, payout_method] = await Promise.all([
      getHostState(me.id),
      getHostApplication(me.id),
      getApplicantProfile(me.id),
      getPayoutMethod(me.id),
    ])
    const profile = {
      ...applicant.onFile,
      doc_type: applicant.doc_type,
      verification_status: applicant.verification_status,
      missing: applicant.missing,
    }
    return NextResponse.json(
      { host_status: state.host_status, application, profile, payout_method, terms_version: HOST_TERMS_VERSION },
      { headers: CORS }
    )
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load application', detail: String(err) }, { status: 500, headers: CORS })
  }
}
