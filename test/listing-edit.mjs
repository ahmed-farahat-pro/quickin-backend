// Full listing edit -> automatic re-review (W3).
// Run:  cd quickin-backend && DATABASE_URL="<url>" BASE_URL=http://127.0.0.1:4000 node test/listing-edit.mjs
//       BASE_URL defaults to the deployed backend.
//
// Covers: PATCH /api/local/listings/:id across EVERY editable field, the photo
// endpoints (add / reorder / set-cover / delete), ownership enforced in SQL, the
// validation rules, and the rule that matters most — every host edit (price and
// discounts included) sets approval_status='pending' + is_published=false and
// notifies the host and the admin queue.
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const B = process.env.BASE_URL || 'https://quickin-backend.vercel.app'
// SSL for Neon, none for a local Postgres — the same test has to run against both, and
// `quickin_local` answers "the server does not support SSL connections". Matches scripts/_e2e.mjs.
const _cs = dbUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })

let P = 0, F = 0
const chk = (c, l, x = '') => { console.log(`${c ? '  PASS' : '  FAIL'} ${l}${x ? '  (' + x + ')' : ''}`); c ? P++ : F++ }
const req = async (m, p, t, b) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  })
  return { s: r.status, b: await r.json().catch(() => ({})) }
}
const otp = async (e) => (await pool.query('select otp_code from users where lower(email)=lower($1)', [e])).rows[0]?.otp_code
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0]

const HOST = 'ledit.host@problem-x.com', OTHER = 'ledit.other@problem-x.com'
const EMAILS = [HOST, OTHER]
const TITLES = ['Edit Me Villa', 'Renamed Villa', 'One Shot Save', 'Zero Rate Villa']
// 'before' / 'after' used to stand here. listing-completeness-policy now holds
// BOTH doors to a real description, so a one-word one 400s on create and on
// every edit that touches it.
const DESC_BEFORE = 'A bright villa by the water, before the edit.'
const DESC_AFTER = 'A bright villa by the water, after the edit.'
async function clean() {
  await pool.query(`delete from notifications where user_id in (select id from users where email=any($1))`, [EMAILS])
  // the re-queue also notifies admins — drop those so a run leaves nothing behind
  for (const title of TITLES) await pool.query(`delete from notifications where type='listing_pending' and body like '%'||$1||'%'`, [title])
  await pool.query(`delete from listing_images where listing_id in (select id from listings where host_id in (select id from users where email=any($1)))`, [EMAILS])
  await pool.query(`delete from listings where host_id in (select id from users where email=any($1))`, [EMAILS])
  await pool.query(`delete from users where email=any($1)`, [EMAILS])
}
// Sign up + verify, then grant hosting the way an admin approval does (this test
// is about editing a listing, not about the host-application flow — and doing it
// in SQL keeps it runnable without admin credentials). The token carries no
// authority of its own: the role is re-read from the DB on every request.
async function host(email) {
  // Password-policy.ts wants a symbol AND refuses the common shapes, so this is
  // deliberately unguessable — without it signup 400s and everything below 401s.

  await req('POST', '/api/auth/signup', null, { email, password: 'Ldt#Qk91zv', full_name: 'Listing Edit Host', role: 'host' })
  const token = (await req('POST', '/api/auth/verify-otp', null, { email, code: await otp(email) })).b.token
  // Hosting is granted the way an admin approval does it — including the ID
  // verification that now gates listing create/publish. Without the second
  // column the create door answers 403 `verification_missing` and every
  // assertion below it fails.
  await pool.query(
    `update users set is_host=true, role='host', verification_status='verified' where lower(email)=lower($1)`,
    [email]
  )
  return token
}

;(async () => {
  console.log(`\nListing edit -> re-review vs ${B}\n`)
  await clean()
  const t = await host(HOST), t2 = await host(OTHER)
  const created = await req('POST', '/api/local/listings', t, {
    title: 'Edit Me Villa', description: DESC_BEFORE, location: 'Marassi', country: 'EG', region: 'North Coast',
    price_per_night: 1200, max_guests: 4, bedrooms: 2, beds: 2, bathrooms: 1, property_type: 'Villa',
    lat: 30.9, lng: 28.7, amenities: ['Wifi'], cancellation_policy: 'moderate',
    images: ['https://example.com/p0.jpg', 'https://example.com/p1.jpg', 'https://example.com/p2.jpg'],
  })
  const id = created.b.id
  chk(!!id, 'listing created', id)

  // The create door runs the same seasonal rules as the edit door — it used to
  // run neither, so a wizard that sent `weekend_price: 0` got a 201 back and a
  // listing with no weekend rate at all.
  const base = {
    title: 'Zero Rate Villa', description: DESC_BEFORE, location: 'Marassi', country: 'EG', region: 'North Coast',
    price_per_night: 1200, max_guests: 4, bedrooms: 2, beds: 2, bathrooms: 1, property_type: 'Villa',
    lat: 30.9, lng: 28.7, amenities: ['Wifi'], cancellation_policy: 'moderate',
    images: ['https://example.com/p0.jpg'],
  }
  for (const [label, extra] of [
    ['zero weekend price', { weekend_price: 0 }],
    ['negative weekend price', { weekend_price: -200 }],
    ['zero seasonal month', { monthly_prices: { 8: 0 } }],
    ['seasonal month that is not a number', { monthly_prices: { 8: 'abc' } }],
  ]) chk((await req('POST', '/api/local/listings', t, { ...base, ...extra })).s === 400, `create with a ${label} -> 400`)
  // …and the half that must keep working: no seasonal pricing at all is normal.
  const plain = await req('POST', '/api/local/listings', t, { ...base, weekend_price: null, monthly_prices: {} })
  chk(plain.s === 201, 'create with no seasonal pricing -> 201', String(plain.s))
  // An admin would normally approve; go straight to the DB so the test needs no admin creds.
  const approve = () => pool.query(`update listings set approval_status='approved', is_published=true where id=$1`, [id])
  const state = async () => {
    const r = await one(`select approval_status as a, is_published as p from listings where id=$1`, [id])
    return `${r.a}/${r.p}`
  }

  console.log('Every field is editable, and every edit re-queues')
  await approve()
  const full = await req('PATCH', `/api/local/listings/${id}`, t, {
    title: 'Renamed Villa', description: DESC_AFTER, location: 'Marassi Bay', country: 'EG', region: 'north coast',
    lat: 31.02, lng: 28.61, property_type: 'villa', max_guests: 6, bedrooms: 3, beds: 4, bathrooms: 2,
    amenities: ['Wifi', 'Pool'], price_per_night: 1500, weekend_price: 1800, monthly_prices: { 7: 2100, 13: 9 },
    weekly_discount: 7, monthly_discount: 15, cancellation_policy: 'strict',
  })
  chk(full.s === 200, 'PATCH every field -> 200', String(full.s))
  chk(full.b.approval_status === 'pending', 'response carries approval_status=pending (no refetch needed)')
  chk(await state() === 'pending/false', 'listing is back under review + unpublished')
  const row = await one(`select title, description, location, region, property_type, max_guests, bedrooms, beds,
                                bathrooms, amenities, price_per_night::int p, weekend_price::int wp, monthly_prices mp,
                                weekly_discount wd, monthly_discount md, cancellation_policy cp, lat, lng
                           from listings where id=$1`, [id])
  chk(row.title === 'Renamed Villa' && row.description === DESC_AFTER && row.location === 'Marassi Bay', 'text fields written')
  chk(row.region === 'North Coast' && row.property_type === 'Villa', 'region + property_type canonicalised from lowercase input')
  chk(row.max_guests === 6 && row.bedrooms === 3 && row.beds === 4 && row.bathrooms === 2, 'counts written')
  chk(String(row.amenities) === 'Wifi,Pool' && Number(row.lat) === 31.02 && Number(row.lng) === 28.61, 'amenities + map pin written')
  chk(row.p === 1500 && row.wp === 1800 && row.wd === 7 && row.md === 15 && row.cp === 'strict', 'pricing + policy written')
  chk(JSON.stringify(row.mp) === '{"7":2100}', 'monthly_prices kept valid months only', JSON.stringify(row.mp))

  console.log('The core rule: even a pure price change goes back for review')
  for (const [label, body] of [
    ['price', { price_per_night: 1400 }],
    ['discounts', { weekly_discount: 10, monthly_discount: 20 }],
    ['seasonal pricing', { weekend_price: 1900, monthly_prices: { 8: 2000 } }],
    ['cancellation policy', { cancellation_policy: 'flexible' }],
  ]) {
    await approve()
    const r = await req('PATCH', `/api/local/listings/${id}`, t, body)
    chk(r.s === 200 && r.b.approval_status === 'pending' && (await state()) === 'pending/false', `${label} edit -> pending + unpublished`)
  }

  // The regression this section exists for: /host/:id/edit loads the listing,
  // shows the host their prices and PATCHes them straight back. Handed the GUEST
  // projection it re-saves a commission-inclusive number as the host's own price,
  // marking the listing up again on every single edit. The page has always asked
  // for ?asHost=1; this route ignored it when the two backends were merged.
  console.log('The host edit form reads RAW prices, and only the host does')
  await approve()
  await req('PATCH', `/api/local/listings/${id}`, t, {
    price_per_night: 1000, weekend_price: 2000, monthly_prices: { 7: 3000 },
  })
  // Approve BEFORE reading, and keep every read inside this one approved window:
  // a PATCH re-queues the listing, and a guest read of a listing that is not
  // published answers 404. Reading across a re-queue is how this block compared
  // `undefined` against a real price and called it a pass.
  await approve()
  const guestView = await req('GET', `/api/local/listings/${id}`)
  const hostView = await req('GET', `/api/local/listings/${id}?asHost=1`, t)
  const strangerView = await req('GET', `/api/local/listings/${id}?asHost=1`, t2)
  const anonView = await req('GET', `/api/local/listings/${id}?asHost=1`)
  const offView = await req('GET', `/api/local/listings/${id}?asHost=0`, t)
  chk([guestView, hostView, strangerView, anonView, offView].every((r) => r.s === 200),
    'every projection loads', [guestView, hostView, strangerView, anonView, offView].map((r) => r.s).join('/'))
  const rate = Number(guestView.b.commission_rate) || 0
  chk(hostView.b.price_per_night === 1000, 'asHost=1 answers the raw nightly price', String(hostView.b.price_per_night))
  chk(hostView.b.weekend_price === 2000, 'asHost=1 answers the raw weekend price', String(hostView.b.weekend_price))
  chk(JSON.stringify(hostView.b.monthly_prices) === '{"7":3000}',
    'asHost=1 answers the raw seasonal months', JSON.stringify(hostView.b.monthly_prices))

  if (rate > 0) {
    chk(guestView.b.price_per_night > 1000, 'without the flag the projection is still the guest one', String(guestView.b.price_per_night))
    // Being signed in is not the same as owning the listing. A stranger passing
    // the flag gets the guest projection they would have got anyway.
    chk(strangerView.b.price_per_night === guestView.b.price_per_night,
      'another host passing asHost=1 still gets guest prices', String(strangerView.b.price_per_night))
    chk(anonView.b.price_per_night === guestView.b.price_per_night,
      'and so does a signed-out caller', String(anonView.b.price_per_night))
  } else {
    console.log('  SKIP the projections differ  (commission is 0 on this database)')
  }
  chk(offView.b.price_per_night === guestView.b.price_per_night,
    'asHost=0 means no, rather than "the flag is present"')

  // Saving what the host was shown must be a no-op on the stored price. With the
  // guest projection it was a markup, and it compounded on the next edit.
  await approve()
  await req('PATCH', `/api/local/listings/${id}`, t, {
    price_per_night: hostView.b.price_per_night,
    weekend_price: hostView.b.weekend_price,
    monthly_prices: hostView.b.monthly_prices,
  })
  const resaved = await one(`select price_per_night::int p, weekend_price::int wp, monthly_prices mp
                               from listings where id=$1`, [id])
  chk(resaved.p === 1000 && resaved.wp === 2000 && JSON.stringify(resaved.mp) === '{"7":3000}',
    're-saving the edit form does not mark the listing up', `${resaved.p}/${resaved.wp}/${JSON.stringify(resaved.mp)}`)

  console.log('Only the keys sent are written')
  await approve()
  await req('PATCH', `/api/local/listings/${id}`, t, { beds: 5 })
  const kept = await one(`select title, description, beds from listings where id=$1`, [id])
  chk(kept.title === 'Renamed Villa' && kept.description === DESC_AFTER && kept.beds === 5, 'omitted fields are not nulled out')

  console.log('Ownership is enforced in the SQL, never from the body')
  await approve()
  chk((await req('PATCH', `/api/local/listings/${id}`, t2, { title: 'Hijacked' })).s === 403, 'another host -> 403')
  chk((await req('PATCH', `/api/local/listings/${id}`, t2, { title: 'Hijacked', host_id: created.b.host_id })).s === 403, 'body-supplied host_id is ignored -> 403')
  chk((await req('PATCH', `/api/local/listings/${id}`, null, { title: 'Hijacked' })).s === 401, 'not signed in -> 401')
  chk((await req('PATCH', `/api/local/listings/${id}`, t2, { images: ['https://example.com/x.jpg'] })).s === 403, 'another host cannot replace photos -> 403')
  chk((await state()) === 'approved/true', 'the listing was not touched by any of that')

  console.log('Validation')
  for (const [label, body] of [
    ['blank title', { title: '   ' }], ['blank description', { description: '' }],
    ['zero price', { price_per_night: 0 }], ['negative price', { price_per_night: -5 }],
    ['fractional guests', { max_guests: 2.5 }], ['negative bedrooms', { bedrooms: -1 }],
    // A listing may not be edited down to a place with nowhere to sleep. These
    // three floored at 0 until listing-capacity-policy.ts, which is how "0
    // bedrooms · 0 beds · 0 baths" became a publishable listing.
    ['zero bedrooms', { bedrooms: 0 }], ['zero beds', { beds: 0 }], ['zero bathrooms', { bathrooms: 0 }],
    ['out-of-range lat', { lat: 95 }], ['out-of-range lng', { lng: -181 }],
    ['amenities not a list', { amenities: 'Wifi' }], ['amenities not strings', { amenities: [1, 2] }],
    ['unknown property type', { property_type: 'Yacht' }], ['unknown region', { region: 'Mars' }],
    ['photo with a bad scheme', { images: ['ftp://x/y.png'] }], ['empty body', {}],
    // The seasonal rungs. A typed 0 used to be coerced to "no rate" and stored
    // as NULL / dropped from the map, so the edit saved and the pricing screen
    // reopened blank with nothing said. Empty is still how they are CLEARED —
    // the two cases right below this loop prove that half still works.
    ['zero weekend price', { weekend_price: 0 }], ['negative weekend price', { weekend_price: -200 }],
    ['weekend price that is not a number', { weekend_price: '1,500' }],
    ['zero seasonal month', { monthly_prices: { 8: 0 } }],
    ['negative seasonal month', { monthly_prices: { 8: -200 } }],
    ['seasonal month that is not a number', { monthly_prices: { 8: 'abc' } }],
  ]) chk((await req('PATCH', `/api/local/listings/${id}`, t, body)).s === 400, `${label} -> 400`)
  chk((await state()) === 'approved/true', 'no rejected edit changed anything')

  // …and the refusal names the field, since a host with twelve month fields open
  // needs to know which one to fix.
  const zeroMonth = await req('PATCH', `/api/local/listings/${id}`, t, { monthly_prices: { 8: 0 } })
  chk(/august/i.test(zeroMonth.b.error || ''), 'a zero month is refused BY NAME', zeroMonth.b.error)
  const zeroWeekend = await req('PATCH', `/api/local/listings/${id}`, t, { weekend_price: 0 })
  chk(/weekend price must be greater than 0/i.test(zeroWeekend.b.error || ''),
    'a zero weekend rate says what is wrong with it', zeroWeekend.b.error)

  console.log('Clearing seasonal pricing still works — empty is not zero')
  await approve()
  const cleared = await req('PATCH', `/api/local/listings/${id}`, t, { weekend_price: null, monthly_prices: {} })
  chk(cleared.s === 200, 'null weekend price + empty months -> 200', String(cleared.s))
  const clearedRow = await one(`select weekend_price wp, weekend_days wd, monthly_prices mp from listings where id=$1`, [id])
  chk(clearedRow.wp === null && clearedRow.wd === null, 'clearing the rate takes its days with it',
    `${clearedRow.wp} / ${clearedRow.wd}`)
  chk(JSON.stringify(clearedRow.mp) === '{}', 'seasonal months cleared', JSON.stringify(clearedRow.mp))
  await approve()

  console.log('Photos')
  await approve()
  const added = await req('POST', `/api/local/listings/${id}/images`, t, { images: ['https://example.com/p3.jpg', 'https://example.com/p4.jpg'] })
  chk(added.s === 200 && added.b.listing_images.length === 5, 'add photos -> 200 with the full listing', String(added.b.listing_images?.length))
  chk(added.b.listing_images.every((i) => i.id && i.url), 'photos carry ids so clients can delete / reorder them')
  chk(added.b.approval_status === 'pending' && (await state()) === 'pending/false', 'adding a photo re-queues for review')

  await approve()
  const over = await req('POST', `/api/local/listings/${id}/images`, t, { images: Array.from({ length: 6 }, (_, i) => `https://example.com/over-${i}.jpg`) })
  chk(over.s === 400, 'more than 10 photos -> 400')
  chk((await one(`select count(*)::int c from listing_images where listing_id=$1`, [id])).c === 5, 'rejected add inserted nothing (rolled back)')
  chk((await state()) === 'approved/true', 'a rejected add does not re-queue')
  chk((await req('POST', `/api/local/listings/${id}/images`, t2, { images: ['https://example.com/x.jpg'] })).s === 403, 'another host cannot add photos -> 403')

  const ids = added.b.listing_images.map((i) => i.id)
  await approve()
  const reordered = await req('PATCH', `/api/local/listings/${id}/images`, t, { order: [...ids].reverse() })
  chk(reordered.s === 200 && reordered.b.listing_images[0].id === ids[4], 'reorder -> new cover is the last photo')
  chk((await state()) === 'pending/false', 'reordering re-queues for review')
  chk((await req('PATCH', `/api/local/listings/${id}/images`, t, { order: [ids[0]] })).s === 400, 'partial order -> 400')
  chk((await req('PATCH', `/api/local/listings/${id}/images`, t, { order: [ids[0], ids[0], ids[1], ids[2], ids[3]] })).s === 400, 'duplicate ids in order -> 400')
  chk((await req('PATCH', `/api/local/listings/${id}/images`, t2, { order: ids })).s === 403, 'another host cannot reorder -> 403')

  await approve()
  const cover = await req('PATCH', `/api/local/listings/${id}/images/${ids[2]}`, t, { cover: true })
  chk(cover.s === 200 && cover.b.listing_images[0].id === ids[2], 'set cover -> chosen photo is first')
  chk((await state()) === 'pending/false', 'setting the cover re-queues for review')

  await approve()
  const del = await req('DELETE', `/api/local/listings/${id}/images/${ids[0]}`, t)
  chk(del.s === 200 && del.b.listing_images.length === 4, 'delete photo -> 200 with the full listing')
  chk(del.b.listing_images.map((i) => i.order).join(',') === '0,1,2,3', 'remaining photos are re-packed 0..n-1')
  chk((await state()) === 'pending/false', 'deleting a photo re-queues for review')
  await approve()
  chk((await req('DELETE', `/api/local/listings/${id}/images/${ids[0]}`, t)).s === 403, 'deleting an already-deleted photo -> 403')
  chk((await req('DELETE', `/api/local/listings/${id}/images/${ids[1]}`, t2)).s === 403, 'another host cannot delete a photo -> 403')
  chk((await state()) === 'approved/true', 'none of those touched the listing')

  console.log('Photos can also be saved in one shot with the rest of the form')
  await approve()
  const shot = await req('PATCH', `/api/local/listings/${id}`, t, {
    title: 'One Shot Save', images: ['https://example.com/only-1.jpg', 'https://example.com/only-2.jpg'],
  })
  chk(shot.s === 200 && shot.b.listing_images.map((i) => i.url).join('|') === 'https://example.com/only-1.jpg|https://example.com/only-2.jpg',
    'photo set replaced, array order = display order')
  chk(shot.b.title === 'One Shot Save' && (await state()) === 'pending/false', 'details + photos saved together, re-queued once')

  console.log('The admin queue is told')
  const hostNote = await one(`select count(*)::int c from notifications n join users u on u.id=n.user_id
                               where u.email=$1 and n.type='listing_submitted'`, [HOST])
  chk(hostNote.c > 0, 'host is told the listing is back under review', `${hostNote.c} notifications`)
  const admins = (await one(`select count(*)::int c from users where role='admin'`)).c
  const adminNote = await one(`select count(*)::int c from notifications n join users u on u.id=n.user_id
                                where u.role='admin' and n.type='listing_pending' and n.body like '%One Shot Save%'`)
  if (admins > 0) chk(adminNote.c > 0, 'every admin is pinged about this listing', `${adminNote.c} notifications`)
  else console.log('  SKIP every admin is pinged  (this database has no admin accounts)')
  const queued = await one(`select coalesce(approval_status,'approved') a, is_published p from listings where id=$1`, [id])
  chk(queued.a === 'pending' && queued.p === false, 'listing sits in the moderation queue, hidden from guests')
  const publicSearch = await req('GET', '/api/local/listings?q=One%20Shot%20Save')
  chk(Array.isArray(publicSearch.b) && !publicSearch.b.some((l) => l.id === id), 'and it is gone from public search')

  await clean(); await pool.end()
  console.log(`\n${F === 0 ? '✅ ALL ' + P + ' PASSED' : '❌ ' + F + ' FAILED, ' + P + ' passed'}\n`)
  process.exit(F === 0 ? 0 : 1)
})().catch(async (e) => { console.error('CRASHED:', e.message); try { await pool.end() } catch {} ; process.exit(1) })
