// QuickIn end-to-end flow test (the path web + iOS + Android all exercise).
// Run:  cd quickin-backend && DATABASE_URL="<neon-url>" node test/full-flow.mjs
//       BASE_URL defaults to the deployed backend; override to test local (:4000).
//
// Covers: browse -> host signup+OTP -> create listing (with lat/lng) ->
//         guest signup+OTP -> book (pending) -> chat both ways (+ stranger blocked)
//         -> host confirm -> reservation (confirmed) -> host inbox -> wallet pass.
import pg from 'pg'

const BASE = process.env.BASE_URL || 'https://quickin-backend.vercel.app'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

let pass = 0, fail = 0
const ok = (cond, label) => { (cond ? pass++ : fail++); console.log(`${cond ? '  ✅' : '  ❌'} ${label}`) }
const j = async (r) => ({ status: r.status, ct: r.headers.get('content-type') || '', body: await r.clone().json().catch(() => ({})) })
const post = (p, b, t) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }).then(j)
const patch = (p, b, t) => fetch(BASE + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }).then(j)
const get = (p, t) => fetch(BASE + p, { headers: t ? { Authorization: `Bearer ${t}` } : {} }).then(j)
const otp = async (e) => (await pool.query('select otp_code from users where lower(email)=lower($1)', [e])).rows[0]?.otp_code
async function mk(email, role) {
  const su = await post('/api/auth/signup', { email, password: 'Test12345', full_name: `${role} FlowTest`, role })
  const code = su.body.devCode || await otp(email)
  const v = await post('/api/auth/verify-otp', { email, code })
  return v.body.token
}
const EMAILS = ['flowhost@problem-x.com', 'flowguest@problem-x.com', 'flowstranger@problem-x.com']
async function cleanup() {
  await pool.query(`delete from bookings where listing_id in (select id from listings where title='Full Flow Test Stay')`)
  await pool.query(`delete from listings where title='Full Flow Test Stay'`)
  await pool.query(`delete from users where email = any($1)`, [EMAILS])
}

;(async () => {
  console.log(`\nQuickIn full-flow test against ${BASE}\n`)
  await cleanup()

  console.log('Browse')
  const listings = await get('/api/local/listings')
  ok(listings.status === 200 && Array.isArray(listings.body) && listings.body.length > 0, `listings load (${listings.body.length} found)`)

  console.log('Auth (email + OTP)')
  const host = await mk(EMAILS[0], 'host'); ok(!!host, 'host signup + OTP verify')
  const guest = await mk(EMAILS[1], 'user'); ok(!!guest, 'guest signup + OTP verify')

  console.log('Host posts a listing (with map coords)')
  const cl = await post('/api/local/listings', { title: 'Full Flow Test Stay', description: 'auto-test', location: 'Dubai Marina', country: 'AE', price_per_night: 175, max_guests: 4, bedrooms: 2, beds: 2, bathrooms: 1, property_type: 'Apartment', lat: 25.2048, lng: 55.2708, images: ['https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200&q=80'] }, host)
  ok(cl.status === 201 && cl.body.id, 'create listing -> 201')
  ok(cl.body.lat === 25.2048 && cl.body.lng === 55.2708, 'listing stored lat/lng from the pin')
  const lid = cl.body.id
  const hostListings = await get('/api/local/host/listings', host)
  ok(hostListings.status === 200 && hostListings.body.some((l) => l.id === lid), 'host sees it in /host/listings')

  console.log('Guest books in an available range')
  const bk = await post('/api/local/bookings', { listing_id: lid, check_in: '2026-12-01', check_out: '2026-12-05', guests: 2 }, guest)
  ok(bk.status === 201 && bk.body.status === 'pending', 'booking -> pending (request)')
  ok(!!bk.body.reservation_code, `reservation code issued (${bk.body.reservation_code})`)
  const bid = bk.body.id

  console.log('Chat between host and guest')
  const m1 = await post(`/api/local/bookings/${bid}/messages`, { body: 'Hi! Can I check in early?' }, guest)
  ok(m1.status === 201, 'guest sends a message')
  const hostThread = await get(`/api/local/bookings/${bid}/messages`, host)
  ok(hostThread.status === 200 && hostThread.body.length === 1, 'host reads the message')
  const m2 = await post(`/api/local/bookings/${bid}/messages`, { body: 'Sure — 1pm works.' }, host)
  ok(m2.status === 201, 'host replies')
  const guestThread = await get(`/api/local/bookings/${bid}/messages`, guest)
  ok(guestThread.status === 200 && guestThread.body.length === 2, 'guest sees both, in order')
  const stranger = await mk(EMAILS[2], 'user')
  const blocked = await get(`/api/local/bookings/${bid}/messages`, stranger)
  ok(blocked.status === 403, 'a stranger is blocked from the thread (403)')

  console.log('Host confirms the request')
  const guestCannot = await patch(`/api/local/bookings/${bid}`, { status: 'confirm' }, guest)
  ok(guestCannot.status === 403, 'guest cannot self-confirm (403)')
  const confirm = await patch(`/api/local/bookings/${bid}`, { status: 'confirm' }, host)
  ok(confirm.status === 200 && confirm.body.status === 'confirmed', 'host confirm -> confirmed')

  console.log('Guest sees the confirmed reservation')
  const resv = await get(`/api/local/bookings/${bid}`, guest)
  ok(resv.status === 200 && resv.body.status === 'confirmed' && resv.body.reservation_code, 'reservation shows confirmed + code (for QR)')
  const inbox = await get('/api/local/host/bookings', host)
  ok(inbox.status === 200 && inbox.body.some((b) => b.id === bid && b.status === 'confirmed'), 'host inbox shows it confirmed')

  console.log('Apple Wallet pass')
  const w = await fetch(BASE + '/api/wallet/pass/' + bid)
  const buf = Buffer.from(await w.arrayBuffer())
  const signed = w.status === 200 && (w.headers.get('content-type') || '').includes('pkpass') && buf.slice(0, 2).toString() === 'PK'
  if (signed) ok(true, `wallet mints a signed .pkpass (${buf.length} bytes)`)
  else if (w.status === 501) console.log('  ⚠️  wallet endpoint live but PASS_* env not on Production yet (not a failure)')
  else ok(false, `wallet unexpected ${w.status}`)

  await cleanup()
  console.log(`\n${fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'}\n`)
  await pool.end()
  process.exit(fail === 0 ? 0 : 1)
})().catch(async (e) => { console.error('TEST CRASHED:', e.message); try { await pool.end() } catch {} ; process.exit(1) })
