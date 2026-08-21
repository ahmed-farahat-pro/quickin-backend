import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { adminStats } from '@/lib/local/db'

// Admin (staff session + module permission): GET  → top-line dashboard counts.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'overview')
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json({ stats: await adminStats() }, { headers: CORS })
  } catch (err) {
    console.error('admin stats GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}
