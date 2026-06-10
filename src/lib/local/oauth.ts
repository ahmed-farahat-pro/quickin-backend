import crypto from 'node:crypto'

// REAL OAuth ID-token verification — no third-party SDKs, no npm packages.
// Verifies the RS256 signature against the provider's published JWKS and checks
// the standard claims (iss / aud / exp). Used by /api/auth/google and /api/auth/apple.

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
// Apple "aud" is your Services ID (web) or app bundle id (native iOS).
export const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || ''

interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
  alg?: string
  // Index signature so a Jwk structurally satisfies crypto.JsonWebKey.
  [key: string]: unknown
}

// Small in-memory JWKS cache (keys rotate rarely).
const jwksCache = new Map<string, { keys: Jwk[]; expires: number }>()

async function fetchJwks(url: string): Promise<Jwk[]> {
  const cached = jwksCache.get(url)
  if (cached && cached.expires > Date.now()) return cached.keys
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch JWKS (${res.status})`)
  const body = (await res.json()) as { keys: Jwk[] }
  jwksCache.set(url, { keys: body.keys, expires: Date.now() + 60 * 60 * 1000 })
  return body.keys
}

function decodeSegment(seg: string): any {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
}

export interface VerifiedClaims {
  iss: string
  aud: string | string[]
  exp: number
  email?: string
  email_verified?: boolean | string
  name?: string
  picture?: string
  sub: string
  [k: string]: unknown
}

async function verifyIdToken(
  idToken: string,
  opts: { jwksUrl: string; issuers: string[]; audience: string }
): Promise<VerifiedClaims> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('Malformed token')
  const [headerB64, payloadB64, signatureB64] = parts
  const header = decodeSegment(headerB64)
  const payload = decodeSegment(payloadB64) as VerifiedClaims

  // 1. Signature (RS256) against the provider's JWKS.
  const keys = await fetchJwks(opts.jwksUrl)
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error('Signing key not found in JWKS')
  const publicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' })
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    Buffer.from(signatureB64, 'base64url')
  )
  if (!ok) throw new Error('Invalid token signature')

  // 2. Standard claims.
  if (!opts.issuers.includes(payload.iss)) throw new Error(`Unexpected issuer: ${payload.iss}`)
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (opts.audience && !aud.includes(opts.audience)) throw new Error('Audience mismatch')
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) throw new Error('Token expired')

  return payload
}

/** Verify a Google ID token (the `credential` from Google Identity Services / a Google sign-in). */
export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedClaims> {
  if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is not configured')
  return verifyIdToken(idToken, {
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['accounts.google.com', 'https://accounts.google.com'],
    audience: GOOGLE_CLIENT_ID,
  })
}

/** Verify an Apple identity token (returned by Sign in with Apple). */
export async function verifyAppleIdToken(idToken: string): Promise<VerifiedClaims> {
  if (!APPLE_CLIENT_ID) throw new Error('APPLE_CLIENT_ID is not configured')
  return verifyIdToken(idToken, {
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
    audience: APPLE_CLIENT_ID,
  })
}

export const oauthConfigured = {
  google: () => Boolean(GOOGLE_CLIENT_ID),
  apple: () => Boolean(APPLE_CLIENT_ID),
}
