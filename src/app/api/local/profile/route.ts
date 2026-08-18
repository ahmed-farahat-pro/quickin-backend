import { NextResponse } from 'next/server'
import { getUserFromRequest, getFullProfile, updateProfile } from '@/lib/local/auth'
import { isContactBlockedError } from '@/lib/local/contentguard'
import { canonicalDocumentNumber } from '@/lib/local/id-change-core'

// Profile of the signed-in user.
//   GET   /api/local/profile           → { id, email, full_name, role, age, id_document, phone, … }
//   PATCH /api/local/profile {fields}  → update name / age / phone / bio / avatar / country
// phone is only ever returned here (to the user themselves), never on a listing/booking.
//
// id_document is READ-ONLY here on purpose. It used to be an ordinary editable field,
// which meant any account could rewrite its own identity number at any time with
// nobody reviewing it. Changing it now goes through /api/local/profile/id-change,
// which needs a photo of the document and an operator's approval. Removing the field
// from the apps alone would have left this endpoint as an open back door, so the
// refusal lives here rather than in the UI.
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
      'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.id === 'admin') {
      return NextResponse.json(
        { id: 'admin', email: user.email, full_name: 'Administrator', role: 'admin', provider: 'admin', avatar_url: null, age: null, id_document: null, phone: null },
        { headers: CORS }
      )
    }
    const profile = await getFullProfile(user.id)
    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: CORS })
    return NextResponse.json(profile, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load profile', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    if (user.id === 'admin') return NextResponse.json({ error: 'The admin profile is fixed' }, { status: 400, headers: CORS })
    const b = await req.json().catch(() => ({}))

    // Already-released builds send id_document back on every save, unchanged. Those
    // must keep working, so an identical value is accepted and dropped — it is only an
    // ATTEMPT TO CHANGE the number that is refused, and refused loudly rather than
    // silently ignored: an old app that saved "successfully" and then showed the old
    // number again would look like data loss.
    const submittedId = b.id_document ?? b.idDocument
    if (typeof submittedId === 'string' && submittedId.trim()) {
      const current = await getFullProfile(user.id)
      if (canonicalDocumentNumber(submittedId) !== canonicalDocumentNumber(current?.id_document)) {
        return NextResponse.json(
          {
            error: 'Your ID number can only be changed by request. Submit a change request with a photo of your document.',
            code: 'id_change_required',
          },
          { status: 400, headers: CORS },
        )
      }
    }

    const ageRaw = b.age ?? b.Age
    const updated = await updateProfile(user.id, {
      fullName: typeof b.full_name === 'string' ? b.full_name : typeof b.fullName === 'string' ? b.fullName : null,
      age: ageRaw === '' || ageRaw == null ? null : Number(ageRaw),
      phone: b.phone ?? null,
      bio: typeof b.bio === 'string' ? b.bio : null,
      avatarUrl: b.avatar_url ?? b.avatarUrl ?? null,
      country: typeof b.country === 'string' ? b.country : null,
    })
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    // A name or bio carrying contact details is the user's input to fix, so it
    // answers 400 with the guard's wording rather than a generic failure.
    if (isContactBlockedError(err)) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400, headers: CORS })
    }
    return NextResponse.json({ error: 'Failed to update profile', detail: String(err) }, { status: 500, headers: CORS })
  }
}
