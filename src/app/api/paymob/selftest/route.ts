// TEMPORARY Paymob key self-test. Key-gated. REMOVE after verifying.
// GET ?key=qk-pmtest-4f7a → calls the Intention API with a dummy 100 EGP and reports
// whether your PAYMOB_* keys produce a live Unified-Checkout URL. Charges nothing.
import { NextResponse } from 'next/server'
import { createIntention, paymobConfigured, paymobDiagnostics } from '@/lib/local/paymob'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const KEY = 'qk-pmtest-4f7a'

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get('key') !== KEY) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!paymobConfigured) {
    return NextResponse.json({ ok: false, configured: false, diag: paymobDiagnostics() })
  }
  try {
    const url = new URL(req.url)
    const origin = url.origin
    const override = url.searchParams.get('integration') || undefined
    const r = await createIntention({
      amountCents: 10000, // 100.00 EGP, dummy
      currency: 'EGP',
      specialReference: `selftest__${Date.now()}`,
      billing: { first_name: 'Test', last_name: 'User', email: 'selftest@quickin.app', phone_number: 'NA' },
      notificationUrl: `${origin}/api/paymob/webhook`,
      redirectionUrl: `${origin}/api/paymob/return?booking=selftest`,
      integrationId: override,
    })
    return NextResponse.json({
      ok: true,
      diag: paymobDiagnostics(),
      hasClientSecret: !!r.clientSecret,
      checkout_url: r.checkoutUrl,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, diag: paymobDiagnostics(), error: String(e) })
  }
}
