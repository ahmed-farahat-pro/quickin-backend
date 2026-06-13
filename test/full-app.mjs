// Full-app check focused on the NEW flows (password reset/change, profile, amenities,
// EGP) — reads OTP codes from the DB so it works whether or not SMTP is configured.
//   cd quickin-backend && DATABASE_URL="<neon>" node test/full-app.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const B = process.env.BASE_URL || 'https://quickin-backend.vercel.app'
const pool = new pg.Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } })
let P = 0, F = 0
const chk = (c, l) => { console.log(`${c ? '  PASS' : '  FAIL'} ${l}`); c ? P++ : F++ }
const j = (r) => r.clone().json().catch(() => ({}))
const req = async (m, p, t, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, b: await j(r), raw: r } }
const otp = async (e) => (await pool.query('select otp_code from users where lower(email)=lower($1)', [e])).rows[0]?.otp_code
const EMAILS = ['fullapp.guest@problem-x.com', 'fullapp.host@problem-x.com']
async function cleanup() {
  await pool.query(`delete from listings where host_id in (select id from users where email = any($1))`, [EMAILS])
  await pool.query(`delete from users where email = any($1)`, [EMAILS])
}

;(async () => {
  console.log(`\nFull-app test vs ${B}\n`)
  await cleanup()

  console.log('Browse + currency')
  const ls = await req('GET', '/api/local/listings')
  chk(ls.s === 200 && ls.b.length > 0, `listings load (${ls.b.length})`)
  chk(ls.b.every((l) => l.currency === 'EGP'), 'all listings currency = EGP')

  console.log('Auth')
  const em = EMAILS[0]
  await req('POST', '/api/auth/signup', null, { email: em, password: 'Test12345', full_name: 'Full App', role: 'user' })
  let tok = (await req('POST', '/api/auth/verify-otp', null, { email: em, code: await otp(em) })).b.token
  chk(!!tok, 'signup + OTP verify -> token')

  console.log('Forgot / reset password')
  await req('POST', '/api/auth/forgot-password', null, { email: em })
  const rc = await otp(em)
  chk(!!rc, 'forgot-password set a reset code')
  const rp = await req('POST', '/api/auth/reset-password', null, { email: em, code: rc, password: 'NewPass99' })
  chk(rp.s === 200 && !!rp.b.token, 'reset-password -> token')
  chk((await req('POST', '/api/auth/login', null, { email: em, password: 'NewPass99' })).s === 200, 'login with NEW password')
  chk((await req('POST', '/api/auth/login', null, { email: em, password: 'Test12345' })).s === 401, 'OLD password rejected')
  chk((await req('POST', '/api/auth/reset-password', null, { email: em, code: '000000', password: 'x9zzzz' })).s === 400, 'bad/expired reset code rejected')

  console.log('Change password (profile)')
  tok = (await req('POST', '/api/auth/login', null, { email: em, password: 'NewPass99' })).b.token
  chk((await req('POST', '/api/local/change-password', tok, { current_password: 'WRONG', new_password: 'Zzz12345' })).s === 400, 'wrong current pw rejected')
  chk((await req('POST', '/api/local/change-password', tok, { current_password: 'NewPass99', new_password: 'Zzz12345' })).s === 200, 'change password works')
  chk((await req('POST', '/api/auth/login', null, { email: em, password: 'Zzz12345' })).s === 200, 'login with changed password')

  console.log('Profile (age / id / phone)')
  const up = await req('PATCH', '/api/local/profile', tok, { full_name: 'Full Tester', age: 31, id_document: 'EG998877', phone: '+201234567890' })
  chk(up.b.age === 31 && up.b.phone === '+201234567890' && up.b.id_document === 'EG998877', 'profile age/id/phone saved')
  const me = await req('GET', '/api/local/profile', tok)
  chk(me.b.email === em, 'GET profile returns me')

  console.log('Host: listing with amenities, EGP, no dummy image')
  const hem = EMAILS[1]
  await req('POST', '/api/auth/signup', null, { email: hem, password: 'Test12345', full_name: 'Full Host', role: 'host' })
  const htok = (await req('POST', '/api/auth/verify-otp', null, { email: hem, code: await otp(hem) })).b.token
  const cl = await req('POST', '/api/local/listings', htok, { title: 'Full App Stay', location: 'North Coast', country: 'EG', price_per_night: 900, max_guests: 4, bedrooms: 2, beds: 2, bathrooms: 1, property_type: 'Villa', lat: 30.95, lng: 28.75, images: [], amenities: ['WiFi', 'Pool', 'Kitchen'] })
  chk(cl.b.id && cl.b.currency === 'EGP', 'create listing -> EGP')
  chk(JSON.stringify(cl.b.amenities) === JSON.stringify(['WiFi', 'Pool', 'Kitchen']), 'amenities stored + returned')
  chk(Array.isArray(cl.b.listing_images) && cl.b.listing_images.length === 0, 'no-image listing returns [] (no dummy)')

  console.log('Book -> notify -> confirm -> wallet')
  const bk = await req('POST', '/api/local/bookings', tok, { listing_id: cl.b.id, check_in: '2026-10-01', check_out: '2026-10-04', guests: 2 })
  chk(bk.b.status === 'pending', 'booking pending')
  const hn = await req('GET', '/api/local/notifications', htok)
  chk((hn.b.unreadCount ?? 0) >= 1, 'host got a notification')
  const cf = await req('PATCH', `/api/local/bookings/${bk.b.id}`, htok, { status: 'confirm' })
  chk(cf.b.status === 'confirmed', 'host confirm')
  const w = await fetch(`${B}/api/wallet/pass/${bk.b.id}`)
  const wbuf = Buffer.from(await w.arrayBuffer())
  chk(w.status === 200 && wbuf.slice(0, 2).toString() === 'PK', `wallet signed .pkpass (${wbuf.length} bytes)`)

  await cleanup()
  console.log(`\n${F === 0 ? '✅ ALL ' + P + ' CHECKS PASSED' : '❌ ' + F + ' FAILED, ' + P + ' passed'}\n`)
  await pool.end()
  process.exit(F === 0 ? 0 : 1)
})().catch(async (e) => { console.error('CRASHED:', e.message); try { await pool.end() } catch {}; process.exit(1) })
