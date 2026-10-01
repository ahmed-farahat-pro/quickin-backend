import { NextResponse } from 'next/server'

// Host ⇄ guest messaging was removed on 2026-10-02 in favour of public comments on
// the listing (/api/local/listings/:id/comments). App builds already installed on
// phones still call this route, so it answers 410 with a sentence they can show
// instead of a bare 404. The old threads stay in the database, unread.
export const dynamic = 'force-dynamic'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}
const GONE = { error: 'Messaging has been removed. Ask the host in the listing’s comments.' }

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
