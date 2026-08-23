// Admin-panel password-reset email delivery (A5).
//
// This module came over from quickin-frontend, where it could not send mail itself:
// the SMTP credentials live in THIS project, so it POSTed to /api/mail/send-staff-reset
// with a shared secret and let the backend do the sending. Here that indirection is
// wrong — it would make this project call itself over HTTP to reach a mailer it already
// imports, and it depended on MAIL_BACKEND_URL, which is not set here. Unset, the send
// silently no-ops and a staff password reset never arrives.
//
// So it sends directly. The message is byte-for-byte what the relay produced, because
// the relay is where this wording came from.

import { sendNotificationEmail, smtpConfigured, smtpDiagnostics } from './mailer'

/** Matches the relay's old default when the caller passes nothing sensible. */
const DEFAULT_TTL_MINUTES = 15

/**
 * Send a staff password-reset code.
 *
 * Never throws. The caller must not reveal whether an address exists, so it cannot
 * surface a failure to the requester either way — failures are logged instead.
 * Returns true when the mail was accepted, which the route uses only to decide whether
 * to echo the code back in local dev.
 */
export async function sendStaffResetEmail(to: string, code: string, minutes: number): Promise<boolean> {
  if (!smtpConfigured) {
    // Local dev with no SMTP: log the code so the reset flow is still exercisable.
    // In production this is the operator's only signal that resets are not going out,
    // since the route deliberately answers the same either way.
    console.error(
      `[staff-reset] SMTP not configured — reset code for ${to}: ${code}`,
      smtpDiagnostics(),
    )
    return false
  }
  const ttl = Number(minutes) > 0 ? Number(minutes) : DEFAULT_TTL_MINUTES
  try {
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
    console.log(`[staff-reset] reset code sent to ${to}`)
    return true
  } catch (e) {
    console.error(`[staff-reset] send failed for ${to}: ${e}`)
    return false
  }
}
