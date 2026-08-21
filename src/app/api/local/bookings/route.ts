import { NextResponse } from 'next/server'
import { createBooking, getUserBookings, submitPaymentProof } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// Bookings API (no Supabase). Auth via Bearer token (mobile) or qk_token cookie (web).
//   GET  /api/local/bookings           → the signed-in user's reservations
//   POST /api/local/bookings {listing_id, check_in, check_out, guests, payment_proof?}
//        → reserve; when a base64 payment_proof (Instapay transfer screenshot) is
//          included, the booking is created and the receipt attached in one step
//          (pay-at-booking), leaving it pending host review.
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
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    const bookings = await getUserBookings(user.id)
    return NextResponse.json(bookings, { headers: CORS })
  } catch (err) {
    console.error('GET /api/local/bookings failed:', err)
    return NextResponse.json({ error: 'Failed to load reservations', detail: String(err) }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req)
    if (!user) {
      return NextResponse.json({ error: 'Please sign in to reserve' }, { status: 401, headers: CORS })
    }
    const body = await req.json()
    const listingId = body.listing_id || body.listingId
    const checkIn = body.check_in || body.checkIn
    const checkOut = body.check_out || body.checkOut
    const guests = Number(body.guests || 1)
    if (!listingId || !checkIn || !checkOut) {
      return NextResponse.json({ error: 'listing_id, check_in and check_out are required' }, { status: 400, headers: CORS })
    }
    // Optional Instapay transfer screenshot (pay-at-booking). Validate its shape up
    // front so we never create an orphan booking for an unusable image.
    const proof = body.payment_proof ?? body.paymentProof ?? null
    if (proof != null) {
      const v = String(proof).trim()
      if (!/^data:image\//i.test(v) && !/^https?:\/\//i.test(v)) {
        return NextResponse.json({ error: 'Please attach a valid screenshot of your transfer' }, { status: 400, headers: CORS })
      }
      if (v.length > 3_600_000) {
        return NextResponse.json({ error: 'That screenshot is too large (max ~3.5MB)' }, { status: 400, headers: CORS })
      }
    }
    let booking = await createBooking({
      listingId, userId: user.id, checkIn, checkOut, guests,
      adults: body.adults, children: body.children, infants: body.infants, pets: body.pets,
    })
    if (proof != null) {
      const withProof = await submitPaymentProof(booking.id, user.id, String(proof), body.payment_method || 'instapay')
      if (withProof) booking = withProof
    }
    return NextResponse.json(booking, { status: 201, headers: CORS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('POST /api/local/bookings failed:', msg)
    // Availability / validation problems are client errors.
    const status = /available|after check-in|Invalid|required|screenshot|too large|already paid/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status, headers: CORS })
  }
}
