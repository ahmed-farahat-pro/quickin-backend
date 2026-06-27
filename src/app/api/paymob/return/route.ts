import { NextResponse } from 'next/server'

// Paymob redirects the browser / in-app WebView here after the customer finishes (the
// intention's redirection_url). The booking is marked paid by the webhook (source of truth);
// this page just gives the WebView a known URL to detect (prefix /api/paymob/return) so the
// app can close the sheet and refresh. Clients should watch for this URL and NOT rely on its
// query params for truth.
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const success = sp.get('success') === 'true'
  const booking = sp.get('booking') || ''
  const title = success ? 'Payment received' : 'Payment not completed'
  const msg = success
    ? 'Your reservation is confirmed. You can return to the QuickIn app.'
    : 'No charge was made. You can return to the app and try again.'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QuickIn — ${title}</title>
<meta name="qk-payment-status" content="${success ? 'success' : 'failed'}"/>
<meta name="qk-booking" content="${booking}"/>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F6F1E6;color:#2A2220;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;max-width:380px;margin:20px;padding:32px 28px;border-radius:22px;border:1px solid #EFE6D8;text-align:center}
  .ic{width:64px;height:64px;border-radius:999px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:30px;background:${success ? '#E2F0E9' : '#FBF1DD'};color:${success ? '#1E7A4E' : '#8A6D1F'}}
  h1{font-size:20px;margin:0 0 8px}p{color:#6B6055;font-size:14px;line-height:1.5;margin:0}
</style></head><body>
  <div class="card" data-qk-payment="${success ? 'success' : 'failed'}" data-booking="${booking}">
    <div class="ic">${success ? '✓' : '!'}</div>
    <h1>${title}</h1>
    <p>${msg}</p>
  </div>
</body></html>`
  return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}
