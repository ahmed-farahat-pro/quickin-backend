import { NextResponse } from 'next/server'
import { getUserFromRequest, getFullProfile, updateProfile } from '@/lib/local/auth'

// Profile of the signed-in user.
//   GET   /api/local/profile           → { id, email, full_name, role, age, id_document, phone, … }
//   PATCH /api/local/profile {fields}  → update name / age / id_document / phone
// phone is only ever returned here (to the user themselves), never on a listing/booking.
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
    const ageRaw = b.age ?? b.Age
    const updated = await updateProfile(user.id, {
      fullName: typeof b.full_name === 'string' ? b.full_name : typeof b.fullName === 'string' ? b.fullName : null,
      age: ageRaw === '' || ageRaw == null ? null : Number(ageRaw),
      idDocument: b.id_document ?? b.idDocument ?? null,
      phone: b.phone ?? null,
      bio: typeof b.bio === 'string' ? b.bio : null,
      avatarUrl: b.avatar_url ?? b.avatarUrl ?? null,
    })
    return NextResponse.json(updated, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to update profile', detail: String(err) }, { status: 500, headers: CORS })
  }
}
