import nodemailer from 'nodemailer'

// SMTP mailer for transactional email (sign-up OTP verification).
// Configured via env. Defaults target Namecheap Private Email.
//   SMTP_HOST  (default mail.privateemail.com)
//   SMTP_PORT  (default 465 — SSL; use 587 for STARTTLS)
//   SMTP_USER  full mailbox address (e.g. tech@your-domain.com)
//   SMTP_PASS  mailbox password
//   SMTP_FROM  bare from-address (defaults to SMTP_USER)

const HOST = process.env.SMTP_HOST || 'mail.privateemail.com'
const PORT = parseInt(process.env.SMTP_PORT || '465', 10)
const USER = process.env.SMTP_USER || ''
const PASS = process.env.SMTP_PASS || ''
const FROM = process.env.SMTP_FROM || USER

export const smtpConfigured = Boolean(USER && PASS)

let transporter: nodemailer.Transporter | null = null
function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465, // true for 465 (SSL), false for 587 (STARTTLS)
      auth: { user: USER, pass: PASS },
    })
  }
  return transporter
}

function otpEmailHtml(code: string): string {
  return `
  <div style="background:#F6F1E6;padding:32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;border:1px solid #EFE6D8">
      <div style="background:#5B0F16;padding:22px 28px">
        <span style="color:#F6F1E6;font-size:22px;font-weight:700;letter-spacing:.5px">QuickIn</span>
      </div>
      <div style="padding:28px">
        <h1 style="margin:0 0 8px;color:#2A2220;font-size:20px">Verify your email</h1>
        <p style="margin:0 0 22px;color:#6B6055;font-size:14px;line-height:1.5">
          Enter this code to finish creating your QuickIn account. It expires in 10 minutes.
        </p>
        <div style="text-align:center;margin:0 0 22px">
          <span style="display:inline-block;background:#EFE6D8;color:#5B0F16;font-size:32px;font-weight:700;letter-spacing:10px;padding:14px 24px;border-radius:14px">${code}</span>
        </div>
        <p style="margin:0;color:#9a9088;font-size:12px;line-height:1.5">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    </div>
  </div>`
}

/** Send the sign-up OTP. With no SMTP creds, logs the code (dev fallback) instead of failing. */
export async function sendOtpEmail(to: string, code: string): Promise<void> {
  if (!smtpConfigured) {
    console.log(`[mailer] SMTP not configured — OTP for ${to} is ${code}`)
    return
  }
  await getTransporter().sendMail({
    from: `QuickIn <${FROM}>`,
    to,
    subject: `Your QuickIn verification code: ${code}`,
    text: `Your QuickIn verification code is ${code}. It expires in 10 minutes.`,
    html: otpEmailHtml(code),
  })
}
