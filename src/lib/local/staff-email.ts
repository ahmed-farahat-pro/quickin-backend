// Admin-panel password-reset email delivery (A5). Same shape as ./email.ts: the SMTP
// credentials live on the backend project (quickin-backend), so this delegates the
// send to that backend's internal relay instead of speaking SMTP itself.
//   MAIL_BACKEND_URL   e.g. https://quickin-backend.vercel.app
//   MAIL_RELAY_SECRET  shared secret matching the backend's MAIL_RELAY_SECRET
// When unset (local dev), the code is logged so the reset flow still works offline.

const BACKEND = (process.env.MAIL_BACKEND_URL || '').replace(/\/+$/, '')
const SECRET = process.env.MAIL_RELAY_SECRET || ''

/**
 * Send a staff password-reset code via the backend mail relay.
 *
 * Never throws. The caller must not reveal whether an address exists, so it cannot
 * surface a failure to the requester either way — failures are logged instead.
 * Returns true when the relay accepted the send, which the route uses only to decide
 * whether to echo the code back in local dev.
 */
export async function sendStaffResetEmail(to: string, code: string, minutes: number): Promise<boolean> {
  if (!BACKEND || !SECRET) {
    console.log(`[staff-reset][dev] mail relay not configured — reset code for ${to}: ${code}`)
    return false
  }
  try {
    const res = await fetch(`${BACKEND}/api/mail/send-staff-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-secret': SECRET },
      body: JSON.stringify({ to, code, minutes }),
      cache: 'no-store',
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[staff-reset] relay rejected send for ${to}: ${res.status} ${detail}`)
      return false
    }
    console.log(`[staff-reset] reset code sent to ${to} via backend relay`)
    return true
  } catch (e) {
    console.error(`[staff-reset] relay request failed for ${to}: ${e}`)
    return false
  }
}
