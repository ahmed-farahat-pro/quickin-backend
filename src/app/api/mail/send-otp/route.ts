import { NextResponse } from 'next/server'
import { sendOtpEmail, smtpConfigured, smtpDiagnostics } from '@/lib/local/mailer'

// Internal mail relay. The frontend (quickin-frontend) owns OTP generation,
// storage and verification, but delegates the actual EMAIL SEND to this backend
// because the SMTP credentials live here. Authenticated with a shared secret
// (MAIL_RELAY_SECRET) set on both projects — never call this from a browser.
//   POST /api/mail/send-otp  { to, code }   header: x-relay-secret: <MAIL_RELAY_SECRET>
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

function authorized(req: Request): boolean {
  const expected = process.env.MAIL_RELAY_SECRET
  if (!expected) return false
  const got = req.headers.get('x-relay-secret') || ''
  return got.length > 0 && got === expected
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: CORS })
  }
  try {
    const { to, code } = await req.json()
    if (!to || !code) {
      return NextResponse.json({ error: 'to and code are required' }, { status: 400, headers: CORS })
    }
    if (!smtpConfigured) {
      return NextResponse.json({ error: 'SMTP not configured on relay', diag: smtpDiagnostics() }, { status: 503, headers: CORS })
    }
    await sendOtpEmail(String(to), String(code)) // throws on a real SMTP failure
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('[mail-relay] send-otp failed:', err)
    return NextResponse.json(
      { error: 'send failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 502, headers: CORS }
    )
  }
}
