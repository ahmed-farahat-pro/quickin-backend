import { NextResponse } from 'next/server'
import { getUserFromRequest, getUserById, signToken } from '@/lib/local/auth'
import { pool } from '@/lib/local/pool'

// POST /api/local/host/become — promote the CURRENT signed-in account to a host.
// One unified account (matches the web): there is no separate host registration.
// Sets BOTH role='host' (backend's host flag) and is_host=true (web's flag) so the
// user is recognized as a host on every client + the /ops admin.
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

export async function POST(req: Request) {
  try {
    const me = await getUserFromRequest(req)
    if (!me || me.id === 'admin') {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    }
    await pool.query(`UPDATE users SET role = 'host', is_host = true WHERE id = $1`, [me.id])
    const row = await getUserById(me.id)
    if (!row) return NextResponse.json({ error: 'Account not found' }, { status: 404, headers: CORS })
    // Re-issue a host-scoped token (the old one still resolves correctly since role is
    // read from the DB, but this keeps the client's token in sync).
    const token = signToken({ sub: row.id, email: row.email, role: 'host' })
    const user = {
      id: row.id, email: row.email, full_name: row.full_name,
      provider: row.provider, avatar_url: row.avatar_url, role: 'host', is_host: true,
    }
    const res = NextResponse.json({ ok: true, token, user }, { headers: CORS })
    res.cookies.set('qk_token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return res
  } catch (err) {
    console.error('become host failed:', err)
    return NextResponse.json({ error: 'Could not become a host', detail: String(err) }, { status: 500, headers: CORS })
  }
}
