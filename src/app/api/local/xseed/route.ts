// TEMPORARY review seed. Key-gated. REMOVE after running.
// Creates 2 demo accounts (a guest, and a user who applied + was approved as host),
// 3 published listings (North Coast / Ain Sokhna / El Gouna, real coords + real photos),
// 3 host services, and a PENDING booking by the guest on the host's North Coast listing.
// Idempotent: wipes + recreates the two demo accounts each run.
import { NextResponse } from 'next/server'
import { hashPassword } from '@/lib/local/auth'
import { pool } from '@/lib/local/pool'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const KEY = 'qk-seed-3e9a'

const GUEST = { email: 'guest.demo@quickin-eg.com', pass: 'Demo12345', name: 'Mona Adel' }
const HOST = { email: 'host.demo@quickin-eg.com', pass: 'Demo12345', name: 'Karim Hassan' }

const U = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1280&q=80`
const LISTINGS = [
  {
    title: 'Marina Beachfront Chalet', property_type: 'chalet', region: 'North Coast',
    location: 'Marina, Sidi Abdel Rahman, North Coast', lat: 30.9419, lng: 28.9560,
    price: 4500, bedrooms: 2, beds: 3, bathrooms: 2, max_guests: 5,
    description: 'Bright two-bedroom chalet steps from the Marina lagoon, with a sea-view terrace, shared pool and walkable access to cafés and the beach.',
    images: ['photo-1613490493576-7fde63acd811', 'photo-1505693416388-ac5ce068fe85', 'photo-1502672260266-1c1ef2d93688'],
  },
  {
    title: 'Sokhna Sea-View Villa', property_type: 'villa', region: 'Ain Sokhna',
    location: 'Stella Di Mare, Ain Sokhna, Red Sea', lat: 29.5995, lng: 32.3180,
    price: 6000, bedrooms: 3, beds: 4, bathrooms: 3, max_guests: 7,
    description: 'Private villa overlooking the Red Sea with a heated pool, large garden and direct beach access — ideal for families and weekend getaways from Cairo.',
    images: ['photo-1580587771525-78b9dba3b914', 'photo-1566073771259-6a8506099945', 'photo-1512918728675-ed5a9ecdebfd'],
  },
  {
    title: 'El Gouna Lagoon Studio', property_type: 'studio', region: 'El Gouna',
    location: 'South Marina, El Gouna, Hurghada', lat: 27.3954, lng: 33.6783,
    price: 3800, bedrooms: 1, beds: 1, bathrooms: 1, max_guests: 2,
    description: 'Cosy lagoon-front studio in the heart of El Gouna, a short stroll to Abu Tig Marina restaurants, with a balcony over the water and a shared pool.',
    images: ['photo-1582719478250-c89cae4dc85b', 'photo-1560185007-cde436f6a4d0', 'photo-1571896349842-33c89424de2d'],
  },
]
const SERVICES = [
  { title: 'Private Chef (per evening)', category: 'chef', location: 'North Coast', price: 1500, image: 'photo-1556910103-1c02745aae4d' },
  { title: 'Airport & Door-to-Door Transfer', category: 'transport', location: 'Ain Sokhna', price: 900, image: 'photo-1549924231-f129b911e442' },
  { title: 'Beach Setup & Cleaning', category: 'cleaning', location: 'El Gouna', price: 600, image: 'photo-1581578731548-c64695cc6952' },
]

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get('key') !== KEY) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const steps: string[] = []
  try {
    // 1) wipe prior demo accounts (listings.host_id has no cascade → delete those first)
    for (const em of [GUEST.email, HOST.email]) {
      const { rows } = await pool.query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [em])
      if (rows[0]) {
        await pool.query(`DELETE FROM listings WHERE host_id=$1`, [rows[0].id])
        await pool.query(`DELETE FROM services WHERE host_id=$1`, [rows[0].id])
        await pool.query(`DELETE FROM users WHERE id=$1`, [rows[0].id])
      }
    }
    steps.push('cleaned prior demo accounts')

    // 2) accounts (verified; host is_host + role host)
    const guest = (await pool.query(
      `INSERT INTO users (email, password_hash, full_name, provider, is_host, email_verified, role, country)
       VALUES ($1,$2,$3,'email',false,true,'user','Egypt') RETURNING id`,
      [GUEST.email, hashPassword(GUEST.pass), GUEST.name])).rows[0].id
    const host = (await pool.query(
      `INSERT INTO users (email, password_hash, full_name, provider, is_host, email_verified, role, country)
       VALUES ($1,$2,$3,'email',true,true,'host','Egypt') RETURNING id`,
      [HOST.email, hashPassword(HOST.pass), HOST.name])).rows[0].id
    steps.push('created guest + host accounts')

    // 3) approved host application for the host (so "applied for host" is reflected)
    await pool.query(
      `INSERT INTO host_applications (user_id, full_name, national_id, phone, address, company, notes, status, reviewed_at, reviewed_by)
       VALUES ($1,$2,'29001011234567','+201001234567','Marina, North Coast','Hassan Stays','Approved demo host','approved', now(), 'admin')
       ON CONFLICT (user_id) DO UPDATE SET status='approved', reviewed_at=now(), reviewed_by='admin'`,
      [host, HOST.name])
    steps.push('host application = approved')

    // 4) listings (published) + images
    const listingIds: string[] = []
    for (const l of LISTINGS) {
      const lid = (await pool.query(
        `INSERT INTO listings
           (host_id, title, description, location, country, region, price_per_night, currency,
            bedrooms, beds, bathrooms, max_guests, property_type, lat, lng,
            is_published, is_guest_favorite, approval_status)
         VALUES ($1,$2,$3,$4,'Egypt',$5,$6,'EGP',$7,$8,$9,$10,$11,$12,$13,true,$14,'approved')
         RETURNING id`,
        [host, l.title, l.description, l.location, l.region, l.price, l.bedrooms, l.beds, l.bathrooms, l.max_guests, l.property_type, l.lat, l.lng, l.region === 'North Coast'])).rows[0].id
      listingIds.push(lid)
      let ord = 0
      for (const img of l.images) {
        await pool.query(`INSERT INTO listing_images (listing_id, url, "order") VALUES ($1,$2,$3)`, [lid, U(img), ord++])
      }
    }
    steps.push(`created ${listingIds.length} published listings + images`)

    // 5) host services (published)
    for (const s of SERVICES) {
      await pool.query(
        `INSERT INTO services (host_id, title, description, category, location, price, currency, image_url, is_published)
         VALUES ($1,$2,$3,$4,$5,$6,'EGP',$7,true)`,
        [host, s.title, `${s.title} — arranged by your host in ${s.location}.`, s.category, s.location, s.price, U(s.image)])
    }
    steps.push(`created ${SERVICES.length} services`)

    // 6) pending booking: guest → North Coast listing, 3 nights starting in ~2 weeks
    const nc = listingIds[0]
    const booking = (await pool.query(
      `INSERT INTO bookings (listing_id, user_id, check_in, check_out, guests, adults, total_price, status)
       VALUES ($1,$2, CURRENT_DATE + 14, CURRENT_DATE + 17, 2, 2, $3, 'pending')
       RETURNING 'QK-' || upper(substr(id::text,1,8)) AS code,
                 to_char(check_in,'YYYY-MM-DD') AS check_in, to_char(check_out,'YYYY-MM-DD') AS check_out`,
      [nc, guest, LISTINGS[0].price * 3])).rows[0]
    steps.push('created pending booking (guest → North Coast)')

    return NextResponse.json({
      ok: true, steps,
      accounts: {
        guest: { email: GUEST.email, password: GUEST.pass, role: 'Guest (user)' },
        host: { email: HOST.email, password: HOST.pass, role: 'Host (applied + approved)' },
      },
      seeded: { listings: listingIds.length, services: SERVICES.length, pending_booking: booking },
    })
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String(e) }, { status: 500 })
  }
}
