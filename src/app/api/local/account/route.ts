import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/local/auth'
import { pool } from '@/lib/local/pool'

// Self-service account deletion (App Store 5.1.1(v) / Google Play account-deletion policy).
//   DELETE /api/local/account  (auth)  — permanently deletes the signed-in user + their data.
//   POST   /api/local/account  { confirm:true }  — same (for clients that can't send DELETE bodies).
// Deletes the user's listings first (listings.host_id has no ON DELETE CASCADE); everything
// else referencing the user cascades. Clears the session cookie.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
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
      'Access-Control-Allow-Methods': 'DELETE,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

async function deleteSelf(req: Request) {
  const me = await getUserFromRequest(req)
  if (!me || me.id === 'admin') {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM listings WHERE host_id = $1`, [me.id])
    await client.query(`DELETE FROM users WHERE id = $1`, [me.id])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('account self-delete failed:', e)
    return NextResponse.json({ error: 'Could not delete account' }, { status: 500, headers: CORS })
  } finally {
    client.release()
  }
  const res = NextResponse.json({ ok: true, deleted: true }, { headers: CORS })
  res.cookies.set('qk_token', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
  return res
}

export async function DELETE(req: Request) {
  return deleteSelf(req)
}

export async function POST(req: Request) {
  return deleteSelf(req)
}
