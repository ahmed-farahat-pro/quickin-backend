// =============================================================================
// QuickIn LOCAL ADMIN PANEL — port 3001
// Dependency-free: node:http + the psql client. No Supabase, no npm packages.
// Manages the local quickin_local Postgres: listings (view/add/delete/toggle)
// and users (view).
//   Run:  node local-backend/admin-server.mjs
// =============================================================================
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { URL } from 'node:url'

const execFileAsync = promisify(execFile)
const PSQL = process.env.PSQL_BIN || '/opt/homebrew/opt/libpq/bin/psql'
const CONN = process.env.DATABASE_URL || 'postgresql://ahmedfarahat@127.0.0.1:5432/quickin_local'
const PORT = Number(process.env.ADMIN_PORT || 3001)

const C = { burgundy: '#5B0F16', cream: '#F6F1E6', tan: '#EFE6D8', ink: '#2A2220', muted: '#6B6055' }

// ---- helpers ---------------------------------------------------------------
const q = (v) => `'${String(v).replace(/'/g, "''")}'`
const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const isUuid = (s) => /^[0-9a-fA-F-]{36}$/.test(s)

async function psql(sql) {
  const { stdout } = await execFileAsync(PSQL, ['-tAqX', '--no-psqlrc', '-c', sql, CONN], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}
async function psqlJson(sql) {
  const out = await psql(sql)
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('[') || l.startsWith('{'))
  return line ? JSON.parse(line) : null
}

const getStats = () =>
  psqlJson(`SELECT json_build_object(
    'listings',(SELECT count(*) FROM listings),
    'published',(SELECT count(*) FROM listings WHERE is_published),
    'users',(SELECT count(*) FROM users),
    'images',(SELECT count(*) FROM listing_images))`)
const getListings = () =>
  psqlJson(`SELECT COALESCE(json_agg(json_build_object(
    'id',id,'title',title,'location',location,'price_per_night',price_per_night::float8,
    'is_guest_favorite',is_guest_favorite,'is_published',is_published,
    'img',(SELECT url FROM listing_images li WHERE li.listing_id=listings.id ORDER BY "order" LIMIT 1)
  ) ORDER BY created_at DESC),'[]') FROM listings`)
const getUsers = () =>
  psqlJson(`SELECT COALESCE(json_agg(json_build_object(
    'email',email,'full_name',full_name,'provider',provider,
    'created',to_char(created_at,'YYYY-MM-DD')) ORDER BY created_at),'[]') FROM users`)

// ---- request body ----------------------------------------------------------
const readBody = (req) =>
  new Promise((resolve) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => resolve(b))
  })
const parseForm = (b) => {
  const o = {}
  for (const [k, v] of new URLSearchParams(b)) o[k] = v
  return o
}

// ---- HTML ------------------------------------------------------------------
function statCard(label, value) {
  return `<div style="background:#fff;border-radius:18px;padding:18px 22px;box-shadow:0 4px 16px rgba(42,34,32,.06);min-width:140px">
    <div style="font-size:30px;font-weight:800;color:${C.burgundy}">${value}</div>
    <div style="font-size:13px;color:${C.muted};margin-top:2px">${label}</div></div>`
}

function listingRow(l) {
  const fav = l.is_guest_favorite ? '★' : '—'
  const pub = l.is_published
    ? `<span style="color:#177245;font-weight:600">Published</span>`
    : `<span style="color:${C.muted}">Hidden</span>`
  const thumb = l.img
    ? `<img src="${esc(l.img)}" style="width:54px;height:40px;object-fit:cover;border-radius:8px" />`
    : `<div style="width:54px;height:40px;background:${C.tan};border-radius:8px"></div>`
  return `<tr style="border-top:1px solid ${C.tan}">
    <td style="padding:10px 8px">${thumb}</td>
    <td style="padding:10px 8px;font-weight:600;color:${C.ink}">${esc(l.title)}</td>
    <td style="padding:10px 8px;color:${C.muted}">${esc(l.location || '')}</td>
    <td style="padding:10px 8px;color:${C.ink}">$${l.price_per_night}</td>
    <td style="padding:10px 8px;text-align:center;color:${C.burgundy}">${fav}</td>
    <td style="padding:10px 8px">${pub}</td>
    <td style="padding:10px 8px;white-space:nowrap">
      <form method="post" action="/listings/${l.id}/toggle" style="display:inline">
        <button style="${btn(C.tan, C.ink)}">${l.is_published ? 'Hide' : 'Show'}</button></form>
      <form method="post" action="/listings/${l.id}/delete" style="display:inline" onsubmit="return confirm('Delete this listing?')">
        <button style="${btn('#fff', '#b3261e')};border:1px solid #f0caca">Delete</button></form>
    </td></tr>`
}
const btn = (bg, color) =>
  `background:${bg};color:${color};border:none;border-radius:10px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;margin-right:6px`

function userRow(u) {
  const badge = { google: '#4285F4', apple: '#111', email: C.burgundy }[u.provider] || C.muted
  return `<tr style="border-top:1px solid ${C.tan}">
    <td style="padding:9px 8px;font-weight:600;color:${C.ink}">${esc(u.full_name || '—')}</td>
    <td style="padding:9px 8px;color:${C.muted}">${esc(u.email)}</td>
    <td style="padding:9px 8px"><span style="background:${badge}1a;color:${badge};font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px">${esc(u.provider)}</span></td>
    <td style="padding:9px 8px;color:${C.muted}">${esc(u.created || '')}</td></tr>`
}

function page(stats, listings, users) {
  const field = (name, label, type = 'text', extra = '') =>
    `<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:${C.muted}">${label}
      <input name="${name}" type="${type}" ${extra} style="padding:9px 11px;border:1px solid ${C.tan};border-radius:10px;font-size:14px;background:#fff" /></label>`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>QuickIn Admin</title></head>
  <body style="margin:0;background:${C.cream};color:${C.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:1080px;margin:0 auto;padding:32px 24px 64px">
    <div style="display:flex;align-items:baseline;gap:12px">
      <h1 style="margin:0;font-size:30px;color:${C.burgundy}">QuickIn <span style="font-weight:400;color:${C.ink}">Admin</span></h1>
      <span style="color:${C.muted};font-size:14px">local · no Supabase · :${PORT}</span>
    </div>
    <div style="display:flex;gap:14px;margin:22px 0 32px;flex-wrap:wrap">
      ${statCard('Listings', stats.listings)}
      ${statCard('Published', stats.published)}
      ${statCard('Users', stats.users)}
      ${statCard('Photos', stats.images)}
    </div>

    <h2 style="font-size:18px;margin:0 0 12px">Add a listing</h2>
    <form method="post" action="/listings/create"
      style="background:#fff;border-radius:18px;padding:18px;box-shadow:0 4px 16px rgba(42,34,32,.06);display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;align-items:end;margin-bottom:36px">
      ${field('title', 'Title', 'text', 'required')}
      ${field('location', 'Location')}
      ${field('price', 'Price / night', 'number', 'value="200" min="0"')}
      ${field('bedrooms', 'Bedrooms', 'number', 'value="2" min="0"')}
      ${field('bathrooms', 'Baths', 'number', 'value="1" min="0"')}
      ${field('max_guests', 'Guests', 'number', 'value="4" min="1"')}
      ${field('image', 'Image URL (optional)')}
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:${C.ink};padding-bottom:8px">
        <input type="checkbox" name="favorite" /> Guest favorite</label>
      <button style="${btn(C.burgundy, '#fff')};padding:11px 18px;font-size:15px">Add listing</button>
    </form>

    <h2 style="font-size:18px;margin:0 0 12px">Listings (${listings.length})</h2>
    <div style="background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 16px rgba(42,34,32,.06);margin-bottom:36px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:${C.tan};text-align:left">
          <th style="padding:11px 8px"></th><th style="padding:11px 8px">Title</th><th style="padding:11px 8px">Location</th>
          <th style="padding:11px 8px">Price</th><th style="padding:11px 8px">Fav</th><th style="padding:11px 8px">Status</th><th style="padding:11px 8px"></th>
        </tr></thead><tbody>${listings.map(listingRow).join('')}</tbody></table>
    </div>

    <h2 style="font-size:18px;margin:0 0 12px">Users (${users.length})</h2>
    <div style="background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 16px rgba(42,34,32,.06)">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:${C.tan};text-align:left">
          <th style="padding:11px 8px">Name</th><th style="padding:11px 8px">Email</th><th style="padding:11px 8px">Provider</th><th style="padding:11px 8px">Joined</th>
        </tr></thead><tbody>${users.map(userRow).join('')}</tbody></table>
    </div>
  </div></body></html>`
}

// ---- server ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`)
    const send = (code, body, type = 'text/html') => {
      res.writeHead(code, { 'content-type': type })
      res.end(body)
    }
    const redirect = () => {
      res.writeHead(303, { location: '/' })
      res.end()
    }

    if (req.method === 'GET' && u.pathname === '/') {
      const [stats, listings, users] = await Promise.all([getStats(), getListings(), getUsers()])
      return send(200, page(stats, listings, users))
    }
    if (req.method === 'POST' && u.pathname === '/listings/create') {
      const f = parseForm(await readBody(req))
      if (f.title) {
        const id = (await psql(`INSERT INTO listings
          (title,location,country,price_per_night,currency,bedrooms,beds,bathrooms,max_guests,property_type,is_guest_favorite,is_published)
          VALUES (${q(f.title)},${q(f.location || '')},'',${Number(f.price) || 0},'USD',
            ${Number(f.bedrooms) || 1},${Number(f.bedrooms) || 1},${Number(f.bathrooms) || 1},${Number(f.max_guests) || 2},
            'House',${f.favorite ? 'true' : 'false'},true) RETURNING id`)).trim().split('\n')[0].trim()
        const img = f.image && f.image.trim()
          ? f.image.trim()
          : 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=1200&q=80'
        if (isUuid(id)) await psql(`INSERT INTO listing_images (listing_id,url,"order") VALUES (${q(id)},${q(img)},0)`)
      }
      return redirect()
    }
    const m = u.pathname.match(/^\/listings\/([0-9a-fA-F-]{36})\/(delete|toggle)$/)
    if (req.method === 'POST' && m) {
      const [, id, action] = m
      if (action === 'delete') await psql(`DELETE FROM listings WHERE id=${q(id)}`)
      else await psql(`UPDATE listings SET is_published = NOT is_published WHERE id=${q(id)}`)
      return redirect()
    }
    send(404, 'Not found', 'text/plain')
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('Admin error: ' + (e?.message || e))
  }
})

server.listen(PORT, () => console.log(`QuickIn admin running on http://localhost:${PORT}`))
