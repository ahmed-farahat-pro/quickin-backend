import { NextResponse } from 'next/server'
import { getUserFromRequest, getFullProfile, updateProfile } from '@/lib/local/auth'
import { isContactBlockedError } from '@/lib/local/contentguard'
import { canonicalDocumentNumber } from '@/lib/local/id-change-core'
import { checkName, nameProblemMessage, normalizeName } from '@/lib/local/name-policy'
import { ageProblemMessage, bioProblemMessage, checkAge, checkBio, normalizeBio, parseAge } from '@/lib/local/profile-core'
import { normalizePhone } from '@/lib/local/phone-core'
import { MAX_AVATAR_URL_CHARS, readProfilePatch } from '@/lib/local/profile-patch-core'

// Profile of the signed-in user. The ONE door that writes these columns — the web
// account page, iOS and Android all PATCH here.
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

    // Which fields were actually submitted, and whether each was set or CLEARED.
    // The distinction cannot be made from the values — see profile-patch-core —
    // and getting it wrong is why "remove my photo" used to do nothing.
    const patch = readProfilePatch(b)
    const fields: Parameters<typeof updateProfile>[1] = {}

    // A name is checked here, not only at signup. Signup has refused `12345`
    // since name-policy.ts landed, but this endpoint took whatever string arrived
    // — so a guest could sign up as `Layla` and rename themselves to `0100` a
    // minute later, on the very screen the apps call Edit profile. The name is
    // what a host reads next to a booking request and what an operator matches
    // against an ID document, so the rule has to hold on every door that sets it.
    //
    // A name is also the one field that never clears: everyone has one. A save
    // carrying no name (both apps save the avatar through this same endpoint) is
    // left alone rather than refused for not carrying one.
    if (patch.full_name.kind === 'set') {
      const name = normalizeName(patch.full_name.value)
      const nameProblem = checkName(name)
      if (nameProblem) {
        return NextResponse.json(
          { error: nameProblemMessage(nameProblem), field: 'full_name', nameProblem },
          { status: 400, headers: CORS },
        )
      }
      // Stored normalized, so one name is one name wherever it is read.
      fields.fullName = name
    }

    // The age is a number in a plausible range, decided here and not only in the
    // apps. It reached the database through `Number()`, which reads `01012345678`
    // as the age 1012345678 — a phone number stored in a field that renders as
    // free text on a profile, which is exactly what `contentguard` keeps out of
    // the name and the bio either side of it. The guard cannot see it (the column
    // is an integer, and the digits are not text by the time they arrive), so the
    // range is what closes that door. iOS's `AgeRules` and Android's input filter
    // say the same thing at the field; this is what makes it true of every client.
    if (patch.age.kind === 'set') {
      const ageProblem = checkAge(patch.age.value)
      if (ageProblem) {
        return NextResponse.json(
          { error: ageProblemMessage(ageProblem), field: 'age', ageProblem },
          { status: 400, headers: CORS },
        )
      }
      fields.age = parseAge(patch.age.value)
    } else if (patch.age.kind === 'cleared') {
      fields.age = null
    }

    // Phone, through the same module the host application and the host onboarding
    // use, so the same mobile typed as `+20 10…`, `0020 10…` or `010…` is one
    // number on the row rather than three ways of writing it. This check came
    // across from the `/api/local/users/:id` route the backend merge deleted —
    // without it, moving the web account page here would have dropped it.
    if (patch.phone.kind === 'set') {
      const phone = normalizePhone(patch.phone.value)
      if (!phone) {
        return NextResponse.json(
          { error: 'Enter a valid phone number, like 010 1234 5678', field: 'phone' },
          { status: 400, headers: CORS },
        )
      }
      fields.phone = phone
    } else if (patch.phone.kind === 'cleared') {
      fields.phone = null
    }

    // Bio. Stored normalized, so what the length was judged on is what is kept.
    // The contact guard runs on it in updateProfile — see the note there. The
    // length check also came from the deleted route.
    if (patch.bio.kind === 'set') {
      const bioProblem = checkBio(patch.bio.value)
      if (bioProblem) {
        return NextResponse.json(
          { error: bioProblemMessage(bioProblem), field: 'bio', bioProblem },
          { status: 400, headers: CORS },
        )
      }
      fields.bio = normalizeBio(patch.bio.value)
    } else if (patch.bio.kind === 'cleared') {
      fields.bio = null
    }

    // A data: URL and an https:// URL are both legal here, so the guard is a size
    // cap rather than a shape check — see MAX_AVATAR_URL_CHARS.
    if (patch.avatar_url.kind === 'set') {
      const avatar = String(patch.avatar_url.value)
      if (avatar.length > MAX_AVATAR_URL_CHARS) {
        return NextResponse.json(
          { error: 'That photo is too large — please choose a smaller one', field: 'avatar_url' },
          { status: 400, headers: CORS },
        )
      }
      fields.avatarUrl = avatar
    } else if (patch.avatar_url.kind === 'cleared') {
      fields.avatarUrl = null
    }

    if (patch.country.kind === 'set') fields.country = String(patch.country.value).trim()
    else if (patch.country.kind === 'cleared') fields.country = null

    const updated = await updateProfile(user.id, fields)
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
