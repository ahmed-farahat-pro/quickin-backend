import { pool } from './pool'
import { createSign } from 'node:crypto'
import { FIREBASE_SERVICE_ACCOUNT as HARDCODED_SA } from './firebase-service-account'

// FCM HTTP v1 push — dependency-free. Sends device push ONLY when a Firebase
// service account is configured via the FIREBASE_SERVICE_ACCOUNT env (the JSON
// key as a string); otherwise it no-ops (in-app notifications + email still
// fire). The apps register device tokens via registerDeviceToken().

interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
}

function serviceAccount(): ServiceAccount | null {
  // The FIREBASE_SERVICE_ACCOUNT env wins when set; otherwise fall back to the
  // hardcoded prototype account so push works out of the box.
  let j: { client_email?: string; private_key?: string; project_id?: string } | null = null
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (raw) {
    try {
      j = JSON.parse(raw)
    } catch {
      j = null
    }
  }
  if (!j || !j.client_email || !j.private_key || !j.project_id) {
    j = HARDCODED_SA
  }
  if (j && j.client_email && j.private_key && j.project_id) {
    return {
      client_email: j.client_email,
      private_key: String(j.private_key).replace(/\\n/g, '\n'),
      project_id: j.project_id,
    }
  }
  return null
}

const b64url = (s: string) => Buffer.from(s).toString('base64url')
const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

let cachedToken: { token: string; exp: number } | null = null

// Mint a short-lived OAuth2 access token from the service account (JWT bearer grant).
async function accessToken(sa: ServiceAccount): Promise<string | null> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  signer.end()
  const sig = signer.sign(sa.private_key).toString('base64url')
  const assertion = `${header}.${claim}.${sig}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) {
    console.error('[push] OAuth token request failed:', data)
    return null
  }
  cachedToken = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return data.access_token
}

let warnedNoCreds = false

/** Best-effort device push to all of a user's registered tokens. Never throws. */
export async function sendPush(
  userId: string,
  n: { title: string; body?: string | null; link?: string | null }
): Promise<void> {
  if (!isUuid(userId)) return
  const sa = serviceAccount()
  if (!sa) {
    if (!warnedNoCreds) {
      console.log('[push] FIREBASE_SERVICE_ACCOUNT not set — skipping device push (in-app + email still sent)')
      warnedNoCreds = true
    }
    return
  }
  try {
    const { rows } = await pool.query(`SELECT token FROM device_tokens WHERE user_id = $1`, [userId])
    if (!rows.length) return
    const token = await accessToken(sa)
    if (!token) return
    const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`
    await Promise.all(
      rows.map(async (r) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: r.token,
              notification: { title: n.title, body: n.body ?? '' },
              data: n.link ? { link: n.link } : {},
            },
          }),
        })
        // Prune tokens FCM reports as gone.
        if (res.status === 404 || res.status === 400) {
          await pool.query(`DELETE FROM device_tokens WHERE token = $1`, [r.token]).catch(() => {})
        }
      })
    )
  } catch (err) {
    console.error('[push] send failed (ignored):', err)
  }
}
