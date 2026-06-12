import { NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PKPass } from 'passkit-generator'
import { getBookingById } from '@/lib/local/db'

// Signed Apple Wallet pass for a confirmed reservation.
//   GET     /api/wallet/pass/:bookingId  → application/vnd.apple.pkpass (a signed .pkpass)
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

/** Load the committed pass template images as Buffers. */
function loadAssets(): Record<string, Buffer> {
  const dir = join(process.cwd(), 'pass-assets')
  const names = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png']
  const buffers: Record<string, Buffer> = {}
  for (const name of names) buffers[name] = readFileSync(join(dir, name))
  return buffers
}

function money(amount: number | null | undefined): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  return `$${n.toFixed(2)}`
}

export async function GET(req: Request, ctx: { params: Promise<{ bookingId: string }> }) {
  // 1. Refuse if any signing material is missing → 501.
  const passTypeId = envStr('PASS_TYPE_ID')
  const teamId = envStr('PASS_TEAM_ID')
  const orgName = envStr('PASS_ORG_NAME')
  const certB64 = envStr('PASS_SIGNER_CERT_B64')
  const keyB64 = envStr('PASS_SIGNER_KEY_B64')
  const wwdrB64 = envStr('PASS_WWDR_B64')
  if (!passTypeId || !teamId || !orgName || !certB64 || !keyB64 || !wwdrB64) {
    return NextResponse.json({ error: 'Wallet pass not configured' }, { status: 501, headers: CORS })
  }

  try {
    const { bookingId } = await ctx.params
    const booking = await getBookingById(bookingId)
    if (!booking) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404, headers: CORS })
    }
    if (booking.status !== 'confirmed') {
      return NextResponse.json({ error: 'Reservation must be confirmed first' }, { status: 400, headers: CORS })
    }

    const reservationCode = booking.reservation_code ?? booking.id

    // 2. Build the signed pass.
    const pass = new PKPass(
      loadAssets(),
      {
        wwdr: pemFromB64('PASS_WWDR_B64'),
        signerCert: pemFromB64('PASS_SIGNER_CERT_B64'),
        signerKey: pemFromB64('PASS_SIGNER_KEY_B64'),
      },
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

    // QR encoding the reservation code (what a host scans on check-in).
    pass.setBarcodes({
      format: 'PKBarcodeFormatQR',
      message: reservationCode,
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
