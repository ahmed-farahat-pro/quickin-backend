import { NextResponse } from 'next/server'
import { getPublicProfile } from '@/lib/local/trust'

// GET /api/local/users/:id → a non-sensitive public profile (name, avatar, bio,
// verification + trust badges, guest rating). NEVER returns phone/email/id.
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const profile = await getPublicProfile(id)
    if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS })
    return NextResponse.json(profile, { headers: CORS })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load profile', detail: String(err) }, { status: 500, headers: CORS })
  }
}
