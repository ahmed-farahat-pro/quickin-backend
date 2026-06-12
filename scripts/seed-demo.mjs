// QuickIn demo seeder — creates ready-to-use guest + host accounts (verified, known
// password), each host with real listings across the three regions, plus one sample
// pending booking so the full reserve→chat→confirm flow is testable immediately.
// It drives the SAME deployed API the apps use (so hashing/schema/validation match),
// reading OTP codes from the DB when SMTP isn't wired.
//
// Run from the quickin-master dir:
//   node ../quickin-backend/scripts/seed-demo.mjs
// or from anywhere:
//   node quickin-backend/scripts/seed-demo.mjs
// Writes demo-accounts.html into the current working directory.
import pg from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const BASE = process.env.BASE_URL || 'https://quickin-backend.vercel.app'
const PASSWORD = 'Demo12345'
const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } })

const post = (p, b, t) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(b),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))

const otpFromDb = async (e) =>
  (await pool.query('select otp_code from users where lower(email)=lower($1)', [e])).rows[0]?.otp_code

async function makeAccount(email, name, role) {
  const su = await post('/api/auth/signup', { email, password: PASSWORD, full_name: name, role })
  if (su.body.token) return su.body.token // pre-existing & upgraded (after cleanup this is rare)
  const code = su.body.devCode || (await otpFromDb(email))
  if (!code) throw new Error(`no OTP for ${email} (status ${su.status}): ${JSON.stringify(su.body)}`)
  const v = await post('/api/auth/verify-otp', { email, code })
  if (!v.body.token) throw new Error(`verify failed for ${email}: ${JSON.stringify(v.body)}`)
  return v.body.token
}

const GUESTS = [
  { email: 'guest.layla@demo.quickin.app', name: 'Layla Hassan' },
  { email: 'guest.omar@demo.quickin.app', name: 'Omar Khaled' },
  { email: 'guest.sara@demo.quickin.app', name: 'Sara Mansour' },
]

const HOSTS = [
  {
    email: 'host.nour@demo.quickin.app',
    name: 'Nour El-Din',
    listings: [
      { title: 'Sahel Beach Villa', region: 'North Coast', location: 'Sidi Abdel Rahman, North Coast', country: 'EG', price_per_night: 280, max_guests: 6, bedrooms: 3, beds: 4, bathrooms: 2, property_type: 'Villa', lat: 30.95, lng: 28.75, image: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=1200&q=80' },
    ],
  },
  {
    email: 'host.tarek@demo.quickin.app',
    name: 'Tarek Aziz',
    listings: [
      { title: 'El Gouna Lagoon House', region: 'El Gouna', location: 'El Gouna, Red Sea', country: 'EG', price_per_night: 220, max_guests: 4, bedrooms: 2, beds: 3, bathrooms: 2, property_type: 'House', lat: 27.3954, lng: 33.6781, image: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200&q=80' },
    ],
  },
  {
    email: 'host.dina@demo.quickin.app',
    name: 'Dina Fouad',
    listings: [
      { title: 'Ain Sokhna Sea-View Chalet', region: 'Ain Sokhna', location: 'Ain Sokhna, Suez', country: 'EG', price_per_night: 160, max_guests: 4, bedrooms: 2, beds: 2, bathrooms: 1, property_type: 'Chalet', lat: 29.6, lng: 32.35, image: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=1200&q=80' },
      { title: 'Porto Sokhna Marina Apartment', region: 'Ain Sokhna', location: 'Porto Sokhna', country: 'EG', price_per_night: 130, max_guests: 3, bedrooms: 1, beds: 2, bathrooms: 1, property_type: 'Apartment', lat: 29.58, lng: 32.36, image: 'https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=1200&q=80' },
    ],
  },
]

// Standalone experiences each host offers (jet ski, diving, …).
const SERVICES_BY_HOST = {
  'host.nour@demo.quickin.app': [
    { title: 'Jet Ski Rental', category: 'Jet Ski', location: 'Sidi Abdel Rahman', price: 60, image: 'https://images.unsplash.com/photo-1530053969600-caed2596d242?w=1200&q=80' },
    { title: 'Private Beach BBQ', category: 'Dining', location: 'North Coast', price: 120, image: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=1200&q=80' },
  ],
  'host.tarek@demo.quickin.app': [
    { title: 'Scuba Diving Trip', category: 'Diving', location: 'El Gouna Reef', price: 90, image: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=1200&q=80' },
  ],
  'host.dina@demo.quickin.app': [
    { title: 'Sunset Yacht Cruise', category: 'Boat', location: 'Ain Sokhna Marina', price: 200, image: 'https://images.unsplash.com/photo-1605281317010-fe5ffe798166?w=1200&q=80' },
    { title: 'Kitesurfing Lesson', category: 'Watersports', location: 'Ain Sokhna', price: 75, image: 'https://images.unsplash.com/photo-1502933691298-84fc14542831?w=1200&q=80' },
  ],
}

async function cleanup() {
  const emails = [...GUESTS, ...HOSTS].map((x) => x.email)
  await pool.query(`delete from bookings where listing_id in (select id from listings where host_id in (select id from users where email = any($1)))`, [emails])
  await pool.query(`delete from listings where host_id in (select id from users where email = any($1))`, [emails])
  await pool.query(`delete from users where email = any($1)`, [emails])
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildHtml(guests, hosts, sample, sub) {
  const guestRows = guests
    .map(
      (g) => `<tr><td><span class="pill pill-guest">Guest</span></td><td>${esc(g.name)}</td><td class="mono">${esc(g.email)}</td><td class="mono">${PASSWORD}</td><td class="muted">browse · book · chat · subscribe</td></tr>`
    )
    .join('\n')
  const hostRows = hosts
    .map((h) => {
      const ls = h.listings.map((l) => `${esc(l.title)} <span class="muted">(${esc(l.region)})</span>`).join('<br>')
      const sv = (h.services || []).map((s) => `${esc(s.title)} <span class="muted">($${s.price})</span>`).join('<br>')
      const svBlock = sv ? `<div class="muted" style="margin-top:8px;font-size:12px">Services: ${sv}</div>` : ''
      return `<tr><td><span class="pill pill-host">Host</span></td><td>${esc(h.name)}</td><td class="mono">${esc(h.email)}</td><td class="mono">${PASSWORD}</td><td>${ls || '<span class="muted">—</span>'}${svBlock}</td></tr>`
    })
    .join('\n')
  const sampleNote = sample
    ? `<p class="note"><b>Sample booking seeded:</b> ${esc(sample.guest)} → ${esc(sample.listing)} (status <b>pending</b>) — log in as the host (${esc(sample.host)}) to chat &amp; confirm it.</p>`
    : ''
  const subNote = sub
    ? `<p class="note"><b>Sample subscription seeded:</b> ${esc(sub.guest)} → ${esc(sub.service)} (status <b>pending</b>) — the host accepts it the same way as a booking.</p>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QuickIn — Demo accounts</title>
<style>
  :root{--burgundy:#5B0F16;--cream:#F6F1E6;--tan:#EFE6D8;--ink:#2A2220;--muted:#6B6055}
  *{box-sizing:border-box}
  body{margin:0;background:var(--cream);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;line-height:1.55}
  .wrap{max-width:980px;margin:0 auto;padding:40px 22px 64px}
  header{background:var(--burgundy);color:var(--cream);border-radius:22px;padding:30px 34px;margin-bottom:26px}
  header h1{margin:0 0 6px;font-size:30px;letter-spacing:.3px}
  header p{margin:0;opacity:.85;font-size:15px}
  .card{background:#fff;border:1px solid var(--tan);border-radius:20px;padding:8px 10px;margin-bottom:24px;overflow:auto}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:18px 12px 8px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--tan);vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  tr:last-child td{border-bottom:none}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
  .muted{color:var(--muted)}
  .pill{display:inline-block;padding:3px 11px;border-radius:999px;font-size:12px;font-weight:700}
  .pill-guest{background:var(--tan);color:var(--burgundy)}
  .pill-host{background:var(--burgundy);color:#fff}
  .note{background:#fff;border:1px solid var(--tan);border-left:4px solid var(--burgundy);border-radius:12px;padding:14px 16px;font-size:14px;margin:0 0 24px}
  .tips{font-size:14px;color:var(--ink)}
  .tips li{margin:6px 0}
  a{color:var(--burgundy);font-weight:600}
  code{background:var(--tan);padding:1px 6px;border-radius:6px;font-size:13px}
</style></head>
<body><div class="wrap">
  <header>
    <h1>QuickIn — Demo accounts</h1>
    <p>Ready-to-use logins for testing. Every account is verified — no OTP needed. One shared password.</p>
  </header>

  ${sampleNote}
  ${subNote}

  <div class="card">
    <h2>Guests (book &amp; subscribe)</h2>
    <table><thead><tr><th>Role</th><th>Name</th><th>Email</th><th>Password</th><th>Can do</th></tr></thead>
    <tbody>${guestRows}</tbody></table>
    <h2>Hosts (post places &amp; services)</h2>
    <table><thead><tr><th>Role</th><th>Name</th><th>Email</th><th>Password</th><th>Listings</th></tr></thead>
    <tbody>${hostRows}</tbody></table>
  </div>

  <ul class="tips">
    <li>All passwords are <code>${PASSWORD}</code>. Sign in at <a href="https://quickin-frontend.vercel.app/login">quickin-frontend.vercel.app/login</a>.</li>
    <li>Same email can be <b>both</b> a guest and a host — sign up a guest, then register the same email “as host” to gain hosting.</li>
    <li>Hosts can add listings with a map pin + photos; the map has North Coast / El Gouna / Ain Sokhna tabs.</li>
    <li>Hosts also post <b>Services</b> (jet ski, diving, yacht…); guests browse Services and <b>subscribe</b> — the host accepts it exactly like a booking.</li>
    <li>Hardcoded admin: <span class="mono">admin / Medahny@12345</span> → <a href="https://quickin-frontend.vercel.app/admin">/admin</a>.</li>
  </ul>
</div></body></html>`
}

;(async () => {
  console.log(`\nSeeding QuickIn demo data against ${BASE}\n`)
  await cleanup()

  console.log('Creating guests…')
  const guestTokens = {}
  for (const g of GUESTS) {
    guestTokens[g.email] = await makeAccount(g.email, g.name, 'user')
    console.log(`  ✅ ${g.email}`)
  }

  console.log('Creating hosts + listings…')
  const hostResults = []
  for (const h of HOSTS) {
    const token = await makeAccount(h.email, h.name, 'host')
    const created = []
    for (const l of h.listings) {
      const res = await post('/api/local/listings', {
        title: l.title, description: `${l.property_type} in ${l.location}. Seeded demo listing.`,
        location: l.location, country: l.country, price_per_night: l.price_per_night,
        max_guests: l.max_guests, bedrooms: l.bedrooms, beds: l.beds, bathrooms: l.bathrooms,
        property_type: l.property_type, lat: l.lat, lng: l.lng, images: [l.image],
      }, token)
      if (res.status === 201 && res.body.id) {
        created.push({ id: res.body.id, title: l.title, region: l.region, price: l.price_per_night })
        console.log(`  ✅ ${h.email} → ${l.title}`)
      } else {
        console.log(`  ❌ ${h.email} → ${l.title}: ${res.status} ${JSON.stringify(res.body)}`)
      }
    }
    const createdServices = []
    for (const sv of SERVICES_BY_HOST[h.email] || []) {
      const res = await post('/api/local/services', {
        title: sv.title, description: `${sv.category} experience in ${sv.location}. Seeded demo service.`,
        category: sv.category, location: sv.location, price: sv.price, image_url: sv.image,
      }, token)
      if (res.status === 201 && res.body.id) {
        createdServices.push({ id: res.body.id, title: sv.title, category: sv.category, price: sv.price })
        console.log(`  ✅ ${h.email} → service: ${sv.title}`)
      } else {
        console.log(`  ❌ ${h.email} → service ${sv.title}: ${res.status} ${JSON.stringify(res.body)}`)
      }
    }
    hostResults.push({ ...h, token, listings: created, services: createdServices })
  }

  // One sample pending booking: first guest books the first host's first listing.
  let sample = null
  try {
    const guestToken = guestTokens[GUESTS[0].email]
    const target = hostResults.find((h) => h.listings.length)?.listings[0]
    if (target) {
      const bk = await post('/api/local/bookings', { listing_id: target.id, check_in: '2026-08-01', check_out: '2026-08-04', guests: 2 }, guestToken)
      if (bk.status === 201) {
        const host = hostResults.find((h) => h.listings.some((l) => l.id === target.id))
        sample = { guest: GUESTS[0].name, listing: target.title, host: host.email }
        console.log(`  ✅ sample booking: ${GUESTS[0].name} → ${target.title} (${bk.body.status})`)
      }
    }
  } catch (e) {
    console.log(`  ⚠️  sample booking skipped: ${e.message}`)
  }

  // One sample pending subscription: second guest requests the first service.
  let sub = null
  try {
    const gToken = guestTokens[GUESTS[1].email]
    const svc = hostResults.flatMap((h) => h.services || []).find(Boolean)
    if (svc && gToken) {
      const r = await post('/api/local/service-requests', { service_id: svc.id, note: 'Looking forward to it!' }, gToken)
      if (r.status === 201) {
        sub = { guest: GUESTS[1].name, service: svc.title }
        console.log(`  ✅ sample subscription: ${GUESTS[1].name} → ${svc.title} (${r.body.status})`)
      } else {
        console.log(`  ⚠️  sample subscription: ${r.status} ${JSON.stringify(r.body)}`)
      }
    }
  } catch (e) {
    console.log(`  ⚠️  sample subscription skipped: ${e.message}`)
  }

  const outPath = join(process.cwd(), 'demo-accounts.html')
  writeFileSync(outPath, buildHtml(GUESTS, hostResults, sample, sub))
  console.log(`\n📄 Wrote ${outPath}`)
  console.log(`\nDone. ${GUESTS.length} guests, ${hostResults.length} hosts, ${hostResults.reduce((n, h) => n + h.listings.length, 0)} listings. Password for all: ${PASSWORD}\n`)
  await pool.end()
})().catch(async (e) => {
  console.error('SEED FAILED:', e)
  try { await pool.end() } catch {}
  process.exit(1)
})
