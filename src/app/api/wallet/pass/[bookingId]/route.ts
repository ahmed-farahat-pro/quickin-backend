import { NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PKPass } from 'passkit-generator'
import { getBookingById } from '@/lib/local/db'
import { isLiveStayPass } from '@/lib/local/payment-flow-core'
import { getUserFromRequest } from '@/lib/local/auth'

// Signed Apple Wallet pass for a confirmed AND PAID reservation.
//   GET     /api/wallet/pass/:bookingId  → application/vnd.apple.pkpass (a signed .pkpass)
//
// The pass embeds the reservation code — the credential that resolves /stay/<code> —
// so this route is authenticated to the same guest/host/admin rule the sibling
// booking routes use. It previously had no auth at all, which made any booking id a
// bearer token for that stay's pass.
//   OPTIONS /api/wallet/pass/:bookingId  → CORS preflight
//
// Signing material lives in the backend .env (gitignored), read at runtime:
//   PASS_TYPE_ID, PASS_TEAM_ID, PASS_ORG_NAME,
//   PASS_SIGNER_CERT_B64, PASS_SIGNER_KEY_B64, PASS_WWDR_B64 (base64 of PEMs).
export const runtime = 'nodejs'
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

/** Read a required env var; returns '' when missing/empty. */
function envStr(name: string): string {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim() : ''
}

/** Decode a base64-encoded PEM env var into its PEM string. */
function pemFromB64(name: string): string {
  return Buffer.from(envStr(name), 'base64').toString('utf8')
}

const SIGN_DIR = join(process.cwd(), 'pass-assets', 'signing')
function readMaybe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Pass signing material — from env (base64 PEMs) when set, otherwise the committed
 *  PEM files in pass-assets/signing/. The file fallback lets Production sign passes
 *  with zero env configuration. Returns null only if neither source is complete. */
function loadSigning(): { wwdr: string; signerCert: string; signerKey: string } | null {
  if (envStr('PASS_SIGNER_CERT_B64') && envStr('PASS_SIGNER_KEY_B64') && envStr('PASS_WWDR_B64')) {
    return {
      wwdr: pemFromB64('PASS_WWDR_B64'),
      signerCert: pemFromB64('PASS_SIGNER_CERT_B64'),
      signerKey: pemFromB64('PASS_SIGNER_KEY_B64'),
    }
  }
  const wwdr = readMaybe(join(SIGN_DIR, 'wwdr.pem'))
  const signerCert = readMaybe(join(SIGN_DIR, 'signerCert.pem'))
  const signerKey = readMaybe(join(SIGN_DIR, 'signerKey.pem'))
  if (wwdr && signerCert && signerKey) return { wwdr, signerCert, signerKey }
  return null
}

/** Load the committed pass template images as Buffers. */
function loadAssets(): Record<string, Buffer> {
  const dir = join(process.cwd(), 'pass-assets')
  const names = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png']
  const buffers: Record<string, Buffer> = {}
  for (const name of names) buffers[name] = readFileSync(join(dir, name))
  return buffers
}

/** Where the public stay pass lives (the web project). Same default as
 *  src/lib/local/db.ts, overridable with WEB_URL. */
const WEB_URL = (process.env.WEB_URL || 'https://quickin-frontend.vercel.app').replace(/\/+$/, '')

// Bookings are charged in EGP, so the pass shows EGP (not a $ amount).
function money(amount: number | null | undefined): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  return `EGP ${Math.round(n).toLocaleString('en-US')}`
}

export async function GET(req: Request, ctx: { params: Promise<{ bookingId: string }> }) {
  // 1. Resolve signing material (env base64, else committed PEM files) + metadata.
  const passTypeId = envStr('PASS_TYPE_ID') || 'pass.com.quick'
  const teamId = envStr('PASS_TEAM_ID') || '97DNR5Y3Y5'
  const orgName = envStr('PASS_ORG_NAME') || 'QuickIn'
  const signing = loadSigning()
  if (!signing) {
    return NextResponse.json({ error: 'Wallet pass not configured' }, { status: 501, headers: CORS })
  }

  try {
    const { bookingId } = await ctx.params
    const user = await getUserFromRequest(req)
    if (!user) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: CORS })
    }
    const booking = await getBookingById(bookingId)
    if (!booking) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    }
    // Same rule as GET /api/local/bookings/:id — the guest on the reservation, the
    // host being stayed with, or an operator. Checked AFTER the 404 so this never
    // reveals whether an id exists to someone who cannot see it either way.
    if (booking.user_id !== user.id && booking.host_id !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403, headers: CORS })
    }
    // No pass until the stay is confirmed AND PAID (or already completed) — the
    // shared `isLiveStayPass` rule, identical on the web, iOS and Android. Host
    // approval alone is not enough: it mints the reservation code but the guest
    // pays afterwards, so signing a pass here would put a working QR in both
    // parties' Wallets for a stay nobody has paid for. Never fall back to the
    // booking id either — that would print a QR pointing at a /stay/<uuid> that
    // can never resolve.
    if (!booking.reservation_code) {
      return NextResponse.json({ error: 'Reservation must be confirmed first' }, { status: 400, headers: CORS })
    }
    if (!isLiveStayPass(booking)) {
      return NextResponse.json(
        { error: 'Reservation must be paid and confirmed first' },
        { status: 400, headers: CORS }
      )
    }

    const reservationCode = booking.reservation_code

    // 2. Build the signed pass.
    const pass = new PKPass(
      loadAssets(),
      signing,
      {
        organizationName: orgName,
        description: 'QuickIn reservation',
        passTypeIdentifier: passTypeId,
        teamIdentifier: teamId,
        serialNumber: booking.id,
        logoText: orgName,
        backgroundColor: 'rgb(91,15,22)',
        foregroundColor: 'rgb(246,241,230)',
        labelColor: 'rgb(239,230,216)',
      }
    )

    // eventTicket layout — initializes the field arrays.
    pass.type = 'eventTicket'

    // QR encoding the PUBLIC STAY-PASS URL — the same thing the in-app QR on web,
    // iOS and Android encodes, so a scan (by the guest's camera or the host's
    // phone) opens the pass page with the host's stay guide instead of showing a
    // bare string. `altText` keeps the human-readable code under the barcode for
    // a manual check-in. Never falls back to the booking id: the pass page
    // resolves by reservation_code, and the guard above already required one.
    pass.setBarcodes({
      format: 'PKBarcodeFormatQR',
      message: `${WEB_URL}/stay/${encodeURIComponent(reservationCode)}`,
      messageEncoding: 'iso-8859-1',
      altText: reservationCode,
    })

    // Primary: the place.
    pass.primaryFields.push({
      key: 'place',
      label: 'Reservation',
      value: booking.title,
    })

    // Secondary: check-in / check-out.
    pass.secondaryFields.push(
      { key: 'check_in', label: 'Check-in', value: booking.check_in },
      { key: 'check_out', label: 'Check-out', value: booking.check_out }
    )

    // Auxiliary: guests + total.
    pass.auxiliaryFields.push(
      { key: 'guests', label: 'Guests', value: String(booking.guests) },
      { key: 'total', label: 'Total', value: money(booking.total_price) }
    )

    // Back: full details, including the location and status.
    pass.backFields.push(
      { key: 'location', label: 'Location', value: booking.location ?? '—' },
      { key: 'reservation_code', label: 'Reservation code', value: reservationCode },
      { key: 'status', label: 'Status', value: booking.status },
      { key: 'check_in_back', label: 'Check-in', value: booking.check_in },
      { key: 'check_out_back', label: 'Check-out', value: booking.check_out },
      { key: 'guests_back', label: 'Guests', value: String(booking.guests) },
      { key: 'total_back', label: 'Total', value: money(booking.total_price) }
    )

    const buffer = pass.getAsBuffer()

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': `attachment; filename="quickin-${reservationCode}.pkpass"`,
        ...CORS,
      },
    })
  } catch (err) {
    console.error('GET /api/wallet/pass/[bookingId] failed:', err)
    return NextResponse.json(
      { error: 'Failed to build wallet pass', detail: String(err) },
      { status: 500, headers: CORS }
    )
  }
}
