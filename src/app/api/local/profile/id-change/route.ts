import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import {
  cancelIdChangeRequest,
  getIdChangeState,
  submitIdChangeRequest,
} from '@/lib/local/id-changes'
import { isIdChangeError } from '@/lib/local/id-change-core'
import { isHostVerificationError, normalizeDocType } from '@/lib/local/host-verification-core'

// The signed-in user's identity-number change request.
//   GET    /api/local/profile/id-change  → { current, request, can_request }
//   POST   /api/local/profile/id-change  { requested_value, doc_type, front, back?, reason? }
//   DELETE /api/local/profile/id-change  → withdraw a request still awaiting review
//
// This exists because `users.id_document` is no longer editable through
// PATCH /api/local/profile. The number is identity, and it used to be a free-text
// field any account could rewrite with nobody reviewing it. A change now needs a photo
// of the document and an operator's decision in /ops → ID verifications.
//
// The document type comes from host-verification-core's DOC_TYPES, so a request and a
// verification always mean the same thing by 'passport'.
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
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

/** Both cores throw for input a human should fix; everything else is a real failure. */
function badInput(err: unknown): boolean {
  return isIdChangeError(err) || isHostVerificationError(err)
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    return NextResponse.json(await getIdChangeState(user.id), { headers: CORS })
  } catch (err) {
    console.error('profile id-change GET:', err)
    return NextResponse.json({ error: 'Failed to load your request' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    const b = await req.json().catch(() => ({}))

    // Throws when absent or unknown rather than defaulting: the reviewer checks the
    // photo against the declared type, so filing a passport as a national ID would
    // mislead them into rejecting a valid document.
    const docType = normalizeDocType(b.doc_type ?? b.docType)

    const state = await submitIdChangeRequest({
      userId: user.id,
      requestedValue: b.requested_value ?? b.requestedValue ?? b.id_document,
      docType,
      front: b.front ?? b.image ?? b.doc,
      back: b.back,
      reason: b.reason,
    })
    return NextResponse.json(state, { headers: CORS })
  } catch (err) {
    if (badInput(err)) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400, headers: CORS })
    }
    console.error('profile id-change POST:', err)
    return NextResponse.json({ error: 'Could not submit your request' }, { status: 500, headers: CORS })
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: CORS })
    return NextResponse.json(await cancelIdChangeRequest(user.id), { headers: CORS })
  } catch (err) {
    if (badInput(err)) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400, headers: CORS })
    }
    console.error('profile id-change DELETE:', err)
    return NextResponse.json({ error: 'Could not withdraw your request' }, { status: 500, headers: CORS })
  }
}
