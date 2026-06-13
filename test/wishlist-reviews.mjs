import pg from 'pg'
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url),'utf8')
const DB=(process.env.DATABASE_URL||env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,''))
const B=process.env.BASE_URL||'https://quickin-backend.vercel.app'
const pool=new pg.Pool({connectionString:DB,ssl:{rejectUnauthorized:false}})
let P=0,F=0;const chk=(c,l,x='')=>{console.log(`${c?'  PASS':'  FAIL'} ${l}${x?'  ('+x+')':''}`);c?P++:F++}
const req=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:`Bearer ${t}`}:{})},body:b?JSON.stringify(b):undefined});return{s:r.status,b:await r.json().catch(()=>({}))}}
const otp=async e=>(await pool.query('select otp_code from users where lower(email)=lower($1)',[e])).rows[0]?.otp_code
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const G='wr.guest@problem-x.com',H='wr.host@problem-x.com'
async function clean(){await pool.query(`delete from reviews where user_id in (select id from users where email=any($1))`,[[G,H]]);await pool.query(`delete from wishlists where user_id in (select id from users where email=any($1))`,[[G,H]]);await pool.query(`delete from bookings where user_id in (select id from users where email=any($1))`,[[G,H]]);await pool.query(`delete from listings where host_id in (select id from users where email=any($1))`,[[G,H]]);await pool.query(`delete from users where email=any($1)`,[[G,H]])}
;(async()=>{
  console.log(`\nWishlist + Reviews vs ${B}\n`); await clean()
  // wait for deploy: /api/local/wishlist must exist (401 without token, not 404)
  let w0,waited=0
  while(waited<180){ w0=await fetch(B+'/api/local/wishlist'); if(w0.status===401) break; console.log(`  ...waiting for deploy ${waited}s (got ${w0.status})`); await sleep(12); waited+=12 }
  chk(w0.status===401,'wishlist route deployed (401 unauth)')
  // accounts
  await req('POST','/api/auth/signup',null,{email:H,password:'Test12345',full_name:'WR Host',role:'host'})
  const ht=(await req('POST','/api/auth/verify-otp',null,{email:H,code:await otp(H)})).b.token
  await req('POST','/api/auth/signup',null,{email:G,password:'Test12345',full_name:'WR Guest',role:'user'})
  const gt=(await req('POST','/api/auth/verify-otp',null,{email:G,code:await otp(G)})).b.token
  const cl=await req('POST','/api/local/listings',ht,{title:'Review Test Villa',location:'El Gouna',country:'EG',price_per_night:1000,max_guests:4,bedrooms:2,beds:2,bathrooms:1,property_type:'Villa',region:'El Gouna',lat:27.39,lng:33.67,images:[]})
  const lid=cl.b.id
  // WISHLIST
  chk((await req('POST','/api/local/wishlist',gt,{item_type:'listing',item_id:lid})).b.saved===true,'add listing to wishlist (saved=true)')
  const wl=await req('GET','/api/local/wishlist',gt)
  chk(wl.b.listings?.length===1 && wl.b.listingIds?.includes(lid),'wishlist GET returns the saved listing')
  chk((await req('POST','/api/local/wishlist',gt,{item_type:'listing',item_id:lid})).b.saved===false,'toggle off (saved=false)')
  chk((await req('GET','/api/local/wishlist',gt)).b.listings?.length===0,'wishlist now empty')
  // REVIEWS — past, confirmed booking
  const bk=await req('POST','/api/local/bookings',gt,{listing_id:lid,check_in:'2026-05-01',check_out:'2026-05-04',guests:2})
  const bid=bk.b.id
  await req('PATCH',`/api/local/bookings/${bid}`,ht,{status:'confirm'})
  chk((await req('POST','/api/local/reviews',gt,{booking_id:bid,rating:5,comment:'Amazing stay!'})).s===201,'post review on completed stay -> 201')
  const rv=await req('GET',`/api/local/reviews?listing_id=${lid}`)
  chk(Array.isArray(rv.b)&&rv.b.length===1&&rv.b[0].rating===5&&rv.b[0].reviewer_name,'listing reviews shows it (rating 5 + name)')
  const det=await req('GET',`/api/local/listings/${lid}`)
  chk(det.b.rating===5&&det.b.review_count===1,'listing aggregate rating=5 count=1',`rating=${det.b.rating} count=${det.b.review_count}`)
  // guard: a future/pending booking can't be reviewed
  const bk2=await req('POST','/api/local/bookings',gt,{listing_id:lid,check_in:'2026-12-01',check_out:'2026-12-04',guests:2})
  chk((await req('POST','/api/local/reviews',gt,{booking_id:bk2.b.id,rating:4,comment:'x'})).s===400,'cannot review a stay that is not done yet (400)')
  await clean(); await pool.end()
  console.log(`\n${F===0?'✅ ALL '+P+' PASSED':'❌ '+F+' FAILED, '+P+' passed'}\n`); process.exit(F===0?0:1)
})().catch(async e=>{console.error('CRASHED:',e.message);try{await pool.end()}catch{};process.exit(1)})
