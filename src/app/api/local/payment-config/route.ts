import { NextResponse } from 'next/server'
import { getPaymentConfig } from '@/lib/local/db'
import { getUserFromRequest } from '@/lib/local/auth'

// GET /api/local/payment-config → the Instapay destination shown to a guest at
// checkout: { instapay_handle, instructions, instapay_link, instapay_qr_image,
// qr_payload }. instapay_qr_image is the admin's uploaded QR (a base64 data URL)
// and is '' when they never uploaded one — clients then draw their own QR from
// qr_payload. Signed-in only (the app fetches it on the payment screen).
// Admin-editable via /api/local/admin/settings/instapay.
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
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

export async function GET(req: Request) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
  const cfg = await getPaymentConfig()
  return NextResponse.json(cfg, { headers: CORS })
}
