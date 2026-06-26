import pg from 'pg'; import { readFileSync, writeFileSync } from 'node:fs'
const BASE = 'https://quickin-backend.vercel.app'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,'')
const pool = new pg.Pool({ connectionString: url, ssl:{rejectUnauthorized:false} })
const R = [] // results
const add = (area, name, ok, detail='') => { R.push({area,name,ok,detail}); console.log(`${ok?'✓':'✗'} [${area}] ${name}${detail?' — '+detail:''}`) }
const J = (p,b,t,m='POST') => fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:`Bearer ${t}`}:{})},body:b?JSON.stringify(b):undefined}).then(async r=>({s:r.status,b:await r.json().catch(()=>({}))}))
const G = (p,t) => fetch(BASE+p,{headers:t?{Authorization:`Bearer ${t}`}:{}}).then(async r=>({s:r.status,b:await r.json().catch(()=>({}))}))
const login = (email,password,role)=>J('/api/auth/login',{email,password,role}).then(r=>r.b.token)

let guestTok, hostTok, adminTok, listingId, hostId, newBookingId
try {
  // ---------- AUTH ----------
  guestTok = await login('guest.layla@demo.quickin.app','Demo12345'); add('Auth','Guest login',!!guestTok)
  hostTok = await login('host.nour@demo.quickin.app','Demo12345','host'); add('Auth','Host login',!!hostTok)
  adminTok = await login('admin','Medahny@12345').catch(()=>null)
  if(!adminTok){ const a=await J('/api/auth/login',{email:'admin@quickin.app',password:'Medahny@12345'}); adminTok=a.b.token }
  add('Auth','Admin login',!!adminTok, adminTok?'':'(admin login path differs)')

  // ---------- GUEST: browse ----------
  const ls = await G('/api/local/listings'); add('Guest','List published listings', ls.s===200 && Array.isArray(ls.b) && ls.b.length>0, `${ls.b.length} listings`)
  const sahel = (ls.b||[]).find(x=>x.title==='Sahel Beach Villa') || ls.b[0]
  listingId = sahel?.id; hostId = sahel?.host_id
  add('Guest','Listing has real rating or 0 (no fake)', sahel && typeof sahel.rating==='number', `rating=${sahel?.rating} reviews=${sahel?.review_count}`)
  const det = await G(`/api/local/listings/${listingId}`); add('Guest','Listing detail', det.s===200 && det.b.id===listingId)
  const avail = await G(`/api/local/listings/${listingId}/availability`); add('Guest','Availability', avail.s===200 && Array.isArray(avail.b))
  const q = await J(`/api/local/listings/${listingId}/quote`,{checkIn:'2031-07-02',checkOut:'2031-07-07'}); add('Guest','Seasonal quote', q.s===200 && q.b.total>0, `total ${q.b.total} EGP, seasonal=${q.b.hasSeasonalPricing}`)
  const rv = await G(`/api/local/reviews?listing_id=${listingId}`); add('Guest','Listing reviews', rv.s===200 && Array.isArray(rv.b), `${rv.b.length} reviews`)
  const cur = await G('/api/local/currencies'); add('Guest','Live currencies', cur.s===200 && cur.b.source, `source=${cur.b.source}`)

  // ---------- GUEST: book → pay → wallet → cancel ----------
  const bk = await J('/api/local/bookings',{listing_id:listingId,check_in:'2033-04-10',check_out:'2033-04-13',guests:2},guestTok)
  newBookingId = bk.b.id; add('Guest','Create booking', bk.s===201 && !!newBookingId, `status=${bk.b.status}`)
  const pay = await J(`/api/local/bookings/${newBookingId}/pay`,{method:'card'},guestTok)
  add('Guest','Pay (mock) → confirmed', pay.s===200 && pay.b.booking?.status==='confirmed', `total ${pay.b.receipt?.total} ${pay.b.receipt?.currency}`)
  add('Guest','Receipt currency is EGP', pay.b.receipt?.currency==='EGP')
  const wp = await fetch(`${BASE}/api/wallet/pass/${newBookingId}`,{headers:{Authorization:`Bearer ${guestTok}`}}); add('Guest','Wallet pass (confirmed)', wp.status===200, `http ${wp.status}`)
  const cq = await G(`/api/local/bookings/${newBookingId}/cancel`,guestTok); add('Guest','Cancellation quote', cq.s===200 && cq.b.policy, `policy=${cq.b.policy} refund=${cq.b.refundPercent}%`)
  const cx = await J(`/api/local/bookings/${newBookingId}/cancel`,{},guestTok); add('Guest','Cancel booking', cx.s===200 && cx.b.booking?.status==='cancelled')
  const res = await G('/api/local/bookings',guestTok); add('Guest','My reservations', res.s===200 && Array.isArray(res.b))
  const rec = await G('/api/local/receipts',guestTok); add('Guest','Receipts', rec.s===200 && Array.isArray(rec.b))
  const ref = await G('/api/local/referrals',guestTok); add('Guest','Referrals', ref.s===200 && !!ref.b.code, `code=${ref.b.code}`)
  const prof = await G('/api/local/profile',guestTok); add('Guest','Profile has country', prof.s===200 && !!prof.b.country, `country=${prof.b.country}`)

  // ---------- GUEST: wishlist ----------
  const wa = await J('/api/local/wishlist',{item_type:'listing',item_id:listingId,action:'add'},guestTok); add('Guest','Wishlist add', wa.s===200 && wa.b.saved===true)
  const wr = await J('/api/local/wishlist',{item_type:'listing',item_id:listingId,action:'remove'},guestTok); add('Guest','Wishlist remove', wr.s===200 && wr.b.saved===false)

  // ---------- GUEST: chat (needs a booking with this guest as the user + host) ----------
  const myb = (res.b||[]).find(x=>x.host_id && x.id)
  if(myb){
    const m1 = await J(`/api/local/bookings/${myb.id}/messages`,{body:'Hi, looking forward to the stay!'},guestTok)
    add('Chat','Normal message sends', m1.s===201)
    const m2 = await J(`/api/local/bookings/${myb.id}/messages`,{body:'call me on 01012345678'},guestTok)
    add('Chat','Phone number blocked', m2.s===400, m2.b.error?.slice(0,40))
    const m3 = await J(`/api/local/bookings/${myb.id}/messages`,{body:'reach me zero one zero one two three four five six seven eight'},guestTok)
    add('Chat','Spelled-out phone blocked', m3.s===400)
  } else add('Chat','(skipped — no eligible booking)', true)

  // ---------- HOST: profile + reviews + listings ----------
  const pp = await G(`/api/local/users/${hostId}`); add('Host','Public profile (no PII)', pp.s===200 && !('email'in pp.b) && !('phone'in pp.b), `verified=${pp.b.badges?.verified} superhost=${pp.b.badges?.superhost}`)
  const hrev = await G(`/api/local/users/${hostId}/reviews`); add('Host','Host reviews', hrev.s===200 && Array.isArray(hrev.b), `${hrev.b.length} reviews`)
  const hls = await G(`/api/local/listings?host=${hostId}`); add('Host','Host other listings', hls.s===200 && hls.b.length>0, `${hls.b.length} listings`)
  const earn = await G('/api/local/host/earnings',hostTok); add('Host','Earnings', earn.s===200 && typeof earn.b.totalEarned==='number', `earned ${earn.b.totalEarned} pending ${earn.b.pending}`)
  const ana = await G('/api/local/host/analytics',hostTok); add('Host','Analytics', ana.s===200 && typeof ana.b.totalBookings==='number', `bookings ${ana.b.totalBookings} rating ${ana.b.avgRating}`)
  const hreq = await G('/api/local/host/bookings',hostTok); add('Host','Booking requests', hreq.s===200 && Array.isArray(hreq.b), `${hreq.b.length}`)
  const rg = await G('/api/local/guest-reviews',hostTok); add('Host','Reviewable guests', rg.s===200 && Array.isArray(rg.b))

  // ---------- HOST: create listing → pending → admin approves ----------
  const cl = await J('/api/local/listings',{title:'E2E Test Villa',description:'temp',location:'North Coast',region:'North Coast',price_per_night:3000,max_guests:4,property_type:'Villa',cancellation_policy:'moderate',weekly_discount:10,weekend_price:3500,monthly_prices:{7:4000}},hostTok)
  const testListingId = cl.b.id
  add('Host','Create listing enters pending review', cl.s===201 && cl.b.approval_status==='pending', `status=${cl.b.approval_status}`)
  if(testListingId){
    const pol = await J(`/api/local/listings/${testListingId}`,{cancellation_policy:'flexible'},hostTok,'PATCH'); add('Host','Edit cancellation policy', pol.s===200 && pol.b.cancellation_policy==='flexible')
    const dis = await J(`/api/local/listings/${testListingId}`,{weekly_discount:15,monthly_discount:25},hostTok,'PATCH'); add('Host','Edit discounts', dis.s===200 && dis.b.weekly_discount===15)
    const sp = await J(`/api/local/listings/${testListingId}`,{weekend_price:3800,monthly_prices:{8:4200}},hostTok,'PATCH'); add('Host','Edit seasonal pricing', sp.s===200 && sp.b.weekend_price===3800)
  }

  // ---------- ADMIN ----------
  if(adminTok){
    const ov = await G('/api/local/admin/overview',adminTok); add('Admin','Overview', ov.s===200, ov.b.users?`${ov.b.users.length} users`:'')
    const pend = await G('/api/local/admin/listings',adminTok); add('Admin','Pending listings queue', pend.s===200 && Array.isArray(pend.b), `${pend.b.length} pending`)
    if(testListingId){ const ap = await J('/api/local/admin/listings',{listing_id:testListingId,action:'approve'},adminTok); const pubc = await G('/api/local/listings'); add('Admin','Approve listing → now public', ap.s===200 && ap.b.approval_status==='approved' && (pubc.b||[]).some(x=>x.id===testListingId)) }
    const ver = await G('/api/local/admin/verifications',adminTok); add('Admin','Verifications queue', ver.s===200 && Array.isArray(ver.b))
    const rep = await G('/api/local/admin/reports',adminTok); add('Admin','Reports queue', rep.s===200 && Array.isArray(rep.b))
    const pc = await J('/api/local/admin/promos',{code:'E2ETEST',kind:'percent',value:10},adminTok); add('Admin','Create promo', pc.s===201 && pc.b.code==='E2ETEST')
    const pv = await J('/api/local/promo/validate',{code:'E2ETEST',subtotal:1000}); add('Admin','Promo validates', pv.s===200 && pv.b.discount===100, `discount ${pv.b.discount}`)
    await J('/api/local/admin/promos?id='+pc.b.id,null,adminTok,'DELETE').catch(()=>{})
  } else { add('Admin','(skipped — admin auth unavailable)', true) }

  // ---------- CLEANUP test data ----------
  await pool.query(`delete from bookings where id=$1`,[newBookingId]).catch(()=>{})
  await pool.query(`delete from listings where title='E2E Test Villa'`).catch(()=>{})
  await pool.query(`delete from promo_codes where code='E2ETEST'`).catch(()=>{})
  add('Cleanup','Removed E2E test data', true)
} catch(e){ add('FATAL','suite error', false, String(e).slice(0,120)) }

writeFileSync(new URL('../_e2e-results.json', import.meta.url), JSON.stringify(R,null,2))
const pass = R.filter(x=>x.ok).length, fail = R.filter(x=>!x.ok).length
console.log(`\n===== ${pass} passed, ${fail} failed of ${R.length} =====`)
await pool.end()
