import { NextResponse } from 'next/server'
import { getUserById, getUserFromRequest, setUserPhone } from '@/lib/local/auth'
import { getHostState, getIdentityState, submitVerificationImages } from '@/lib/local/db'
import { readSignupIdentity } from '@/lib/local/signup-identity'
import { SIGNUP_IDENTITY_SOURCE } from '@/lib/local/signup-identity-core'
import { applySignupRole, readSignupRole } from '@/lib/local/signup-role'

// The "Complete your account" step (signup-identity-core). An account created by
// a first Google sign-in has no phone or ID yet; the clients hold it on a blocking
// screen while `identity_complete` is false and post the same fields the email
// signup form sends.
//   GET  /api/local/account/identity  (auth) — the identity state alone.
//   POST /api/local/account/identity  (auth) { phone, doc_type, id_number, id_front, id_back,
//        role?, host_type, address, company, notes, terms_accepted, payout | refund_method }
//        → 200 identity state + host state | 400 { error, fields } | 409 when nothing is owed.
// The role fields are the email signup's (signup-role-core): a Google user picks
// Guest or Host on this screen and walks the same steps.
// A REJECTED document is re-uploaded through POST /api/local/verification, not here.
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
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  const me = await getUserFromRequest(req)
  if (!me || me.id === 'admin') {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
  }
  return NextResponse.json(await getIdentityState(me.id), { headers: CORS })
}

export async function POST(req: Request) {
  try {
    const me = await getUserFromRequest(req)
    if (!me || me.id === 'admin') {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    }
    const state = await getIdentityState(me.id)
    if (state.identity_complete) {
      return NextResponse.json(
        { error: 'Your account is already complete', ...state },
        { status: 409, headers: CORS }
      )
    }
    const body = await req.json()
    const read = await readSignupIdentity(body, me.email)
    const roleRead = readSignupRole(body)
    if (read.fields || roleRead.fields) {
      return NextResponse.json(
        { error: 'Please check the highlighted fields', fields: { ...read.fields, ...roleRead.fields } },
        { status: 400, headers: CORS }
      )
    }
    const identity = read.identity
    // The reviewer reads the account's name against the document.
    const row = await getUserById(me.id)
    await submitVerificationImages({
      userId: me.id,
      front: identity.idFront,
      back: identity.idBack,
      idNumber: identity.idNumber,
      fullName: row?.full_name ?? null,
      docType: identity.docType,
      source: SIGNUP_IDENTITY_SOURCE,
    })
    await setUserPhone(me.id, identity.phone)
    // An already-approved host (an older Google account) has nothing to apply for.
    const host = await getHostState(me.id)
    const parts = host.is_host || host.host_status === 'pending'
      ? { ...roleRead.parts, role: 'guest' as const, hosting: null }
      : roleRead.parts
    await applySignupRole(me.id, parts, identity, row?.full_name ?? '')
    const [identityState, hostState] = await Promise.all([getIdentityState(me.id), getHostState(me.id)])
    return NextResponse.json({ ...identityState, ...hostState }, { headers: CORS })
  } catch (err) {
    console.error('POST /api/local/account/identity failed:', err)
    return NextResponse.json({ error: 'Could not save your details', detail: String(err) }, { status: 500, headers: CORS })
  }
}
