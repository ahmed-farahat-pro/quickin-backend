import { NextResponse } from 'next/server'
import { getListingById } from '@/lib/local/db'

// GET /api/local/listings/:id → a single listing (no Supabase).
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const listing = await getListingById(id)
    if (!listing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json(listing, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('GET /api/local/listings/[id] failed:', err)
    return NextResponse.json(
      { error: 'Failed to load listing', detail: String(err) },
      { status: 500 }
    )
  }
}
