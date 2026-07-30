import { NextResponse } from 'next/server'
import { sendNotificationEmail, smtpConfigured, smtpDiagnostics } from '@/lib/local/mailer'

// Internal mail relay for admin-panel password resets (A5), the sibling of
// /api/mail/send-otp. The frontend (quickin-frontend) owns the /ops staff accounts,
// generates and verifies the reset code, and delegates only the EMAIL SEND to this
// backend because the SMTP credentials live here. Authenticated with the same shared
// secret (MAIL_RELAY_SECRET) set on both projects — never call this from a browser.
//   POST /api/mail/send-staff-reset  { to, code, minutes? }
//   header: x-relay-secret: <MAIL_RELAY_SECRET>
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
    const { to, code, minutes } = await req.json()
    if (!to || !code) {
      return NextResponse.json({ error: 'to and code are required' }, { status: 400, headers: CORS })
    }
    // Fail loudly on a misconfigured relay: the caller deliberately does not reveal
    // whether the address exists, so this 503 is the operator's only signal.
    if (!smtpConfigured) {
      return NextResponse.json(
        { error: 'SMTP not configured on relay', diag: smtpDiagnostics() },
        { status: 503, headers: CORS }
      )
    }
    const ttl = Number(minutes) > 0 ? Number(minutes) : 15
    await sendNotificationEmail(
      String(to),
      'Reset your QuickIn admin password',
      'Admin password reset',
      [
        `Your admin password reset code is <strong style="font-size:20px;letter-spacing:3px;color:#5B0F16">${String(code)}</strong>.`,
        `It expires in ${ttl} minutes and can only be used once.`,
        'If you did not request this, you can ignore this email — your password has not changed.',
      ]
    )
    return NextResponse.json({ ok: true }, { headers: CORS })
  } catch (err) {
    console.error('[mail-relay] send-staff-reset failed:', err)
    return NextResponse.json(
      { error: 'send failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 502, headers: CORS }
    )
  }
}
