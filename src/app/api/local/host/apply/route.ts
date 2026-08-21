import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import {
  getHostState,
  getVerificationStatusFromTable,
  submitHostApplication,
  HOST_TYPES,
  type HostType,
} from '@/lib/local/db'
import { checkName, nameProblemMessage, normalizeName } from '@/lib/local/name-policy'
import { normalizePhone } from '@/lib/local/phone-core'
import { checkApplicationIdentity } from '@/lib/local/host-verification-core'

// POST /api/local/host/apply — submit (or re-submit after a rejection) a host
// application for admin review. It NEVER grants hosting: only an admin approval in
// /api/local/admin/host-applications flips users.is_host.
//
// The ID documents are part of the application ({ doc_type, id_front, id_back }),
// not a later step: the reviewer approves host status and identity in one
// decision, and there is nothing to read the declared name and national ID
// against without them. An applicant who is already verified — or whose
// submission is already in the queue — does not send them again
// (`checkApplicationIdentity`, the same rule the forms render from).
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
    // Collapses whitespace and drops invisibles as well as trimming, so what we
    // store is exactly what the policy judged.
    const fullName = normalizeName(b.full_name ?? b.fullName)
    const nationalId = str(b.national_id ?? b.nationalId)
    const rawPhone = str(b.phone)
    // Canonical form, or null when it isn't a phone number. Stored normalized so
    // the same mobile sent as `+20 10…` by one client and `010…` by another is
    // one applicant in /ops, and reaches the web's rows in the same shape.
    const phone = normalizePhone(rawPhone)
    const address = str(b.address)
    const hostType = str(b.host_type ?? b.hostType).toLowerCase()
    const company = str(b.company)
    const notes = str(b.notes)

    // Per-field messages so the clients can highlight the offending input
    // (same copy as the web's submitHostApplication). Only company + notes are optional.
    const fields: Record<string, string> = {}
    // Presence is not the test — "12345" is non-empty, so the old `!fullName`
    // check filed it for review as a host's legal name. An operator reads this
    // against the ID photos, so it goes through the same policy signup uses.
    // `nameProblem` is echoed so a client can localize the reason.
    const nameProblem = checkName(fullName)
    if (nameProblem) fields.full_name = nameProblemMessage(nameProblem)
    if (!nationalId) fields.national_id = 'National ID is required'
    // Presence is not the test here either — the apps' field took `asdf` and filed
    // it for review as the number our team would call.
    if (!rawPhone) fields.phone = 'Phone is required'
    else if (!phone) fields.phone = 'Enter a valid phone number, like 010 1234 5678'
    if (!address) fields.address = 'Address is required'
    if (!(HOST_TYPES as readonly string[]).includes(hostType)) fields.host_type = 'Choose individual, company or brokerage'

    // Identity documents. Read from the id_verifications row rather than
    // users.verification_status, because that row is what the reviewer opens and
    // what submitHostApplication links the application to.
    const identity = await getVerificationStatusFromTable(me.id)
    const docType = str(b.doc_type ?? b.docType)
    const idFront = str(b.id_front ?? b.idFront)
    const idBack = str(b.id_back ?? b.idBack)
    Object.assign(
      fields,
      checkApplicationIdentity({
        verificationStatus: identity.status,
        docType,
        idFront,
        idBack,
      })
    )
    if (Object.keys(fields).length) {
      return NextResponse.json(
        nameProblem
          ? { error: 'Please check the highlighted fields', fields, nameProblem }
          : { error: 'Please check the highlighted fields', fields },
        { status: 400, headers: CORS }
      )
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
      phone: phone as string, // non-null: a null phone was refused above
      address,
      host_type: hostType as HostType,
      company: company || null,
      notes: notes || null,
      doc_type: docType || null,
      id_front: idFront || null,
      id_back: idBack || null,
    })
    return NextResponse.json({ ok: true, host_status: 'pending', application }, { headers: CORS })
  } catch (err) {
    console.error('host apply failed:', err)
    return NextResponse.json({ error: 'Could not submit application', detail: String(err) }, { status: 500, headers: CORS })
  }
}
