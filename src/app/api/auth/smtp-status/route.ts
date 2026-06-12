import { NextResponse } from 'next/server'
import { smtpDiagnostics } from '@/lib/local/mailer'

export const dynamic = 'force-dynamic'

// GET /api/auth/smtp-status — confirms whether the SMTP_* env vars actually reached
// THIS runtime (i.e. the Production deployment). Returns only non-secret signals:
// booleans for user/pass/from, the host/port, and a masked user. No values leak.
// Used to diagnose "SMTP not configured" without guessing at the Vercel dashboard.
export async function GET() {
  return NextResponse.json(smtpDiagnostics(), {
    headers: {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
