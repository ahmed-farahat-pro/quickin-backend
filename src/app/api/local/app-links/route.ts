import { NextResponse } from 'next/server'
import { getAppLinks } from '@/lib/local/db'

// Public (no auth): GET /api/local/app-links → { ios, android } store links.
// Consumed by the mobile "download the app" bar on the web. Nulls when unset.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

export async function GET() {
  try {
    return NextResponse.json(await getAppLinks(), { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/app-links failed:', err)
    return NextResponse.json({ ios: null, android: null }, { headers: CORS })
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  })
}
