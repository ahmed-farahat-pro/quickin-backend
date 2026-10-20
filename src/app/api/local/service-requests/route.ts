import { NextResponse } from 'next/server'

// GONE. Services (host-posted experiences — jet ski, diving, tours — that guests
// requested) were removed on 2026-10-20. App builds already installed on phones
// still call this route, so it answers 410 with a sentence they can show instead
// of a bare 404. The `services` / `service_requests` tables are kept, dormant:
// nothing reads or writes them any more, and no row was changed or cancelled.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}
const GONE = { error: 'Services have been removed' }

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET() {
  return NextResponse.json(GONE, { status: 410, headers: CORS })
}

export async function POST() {
  return NextResponse.json(GONE, { status: 410, headers: CORS })
}
