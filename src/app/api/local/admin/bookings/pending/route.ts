import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { adminListPendingBookings } from '@/lib/local/db'

// Admin: GET → pending bookings awaiting host approval (with host + guest info).
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'bookings')
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json({ bookings: await adminListPendingBookings() }, { headers: CORS })
  } catch (err) {
    console.error('admin pending bookings GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}
