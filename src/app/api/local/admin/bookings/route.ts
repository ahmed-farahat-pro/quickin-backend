import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { adminListBookings } from '@/lib/local/db'

// Admin (staff session + module permission): GET  → newest-first bookings with guest + listing info.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'bookings')
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json({ bookings: await adminListBookings() }, { headers: CORS })
  } catch (err) {
    console.error('admin bookings GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}
