import pg from 'pg'
import { readFileSync } from 'node:fs'
const env=readFileSync(new URL('../.env',import.meta.url),'utf8')
const DB=(process.env.DATABASE_URL||env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,''))
const ADMIN_PW=(env.match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]||'').trim().replace(/^["']|["']$/g,'')
const B=process.env.BASE_URL||'https://quickin-backend.vercel.app'
const pool=new pg.Pool({connectionString:DB,ssl:{rejectUnauthorized:false}})
let P=0,F=0;const chk=(c,l,x='')=>{console.log(`${c?'  PASS':'  FAIL'} ${l}${x?'  ('+x+')':''}`);c?P++:F++}
const req=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:`Bearer ${t}`}:{})},body:b?JSON.stringify(b):undefined});return{s:r.status,b:await r.json().catch(()=>({}))}}
const otp=async e=>(await pool.query('select otp_code from users where lower(email)=lower($1)',[e])).rows[0]?.otp_code
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const G='ahr.guest@problem-x.com',H='ahr.host@problem-x.com'
async function clean(){await pool.query(`delete from reviews where user_id in (select id from users where email=any($1))`,[[G,H]]);await pool.query(`delete from bookings where user_id in (select id from users where email=any($1))`,[[G,H]]);await pool.query(`delete from listings where host_id in (select id from users where email=any($1))`,[[G,H]]);await pool.query(`delete from users where email=any($1)`,[[G,H]])}
;(async()=>{
  console.log(`\nAdmin lifecycle + host info + review vs ${B}\n`); await clean()
  // wait for deploy: a listing should carry host_name
  await req('POST','/api/auth/signup',null,{email:H,password:'Test12345',full_name:'Karim Host',role:'host'})
  const ht=(await req('POST','/api/auth/verify-otp',null,{email:H,code:await otp(H)})).b.token
  let cl,waited=0
  while(waited<180){ cl=await req('POST','/api/local/listings',ht,{title:'Host Info Villa',location:'El Gouna',country:'EG',price_per_night:900,max_guests:4,bedrooms:2,beds:2,bathrooms:1,property_type:'Villa',region:'El Gouna',lat:27.39,lng:33.67,images:[]}); if(cl.b.host_name!==undefined) break; console.log(`  ...waiting for deploy ${waited}s`); await sleep(12); waited+=12; await pool.query('delete from listings where id=$1',[cl.b.id]).catch(()=>{}) }
  const lid=cl.b.id
  chk(cl.b.host_name==='Karim Host'&&cl.b.host_id,'listing returns host_name + host_id',cl.b.host_name)
  // more from this host
  const byHost=await req('GET',`/api/local/listings?host=${cl.b.host_id}`)
  chk(Array.isArray(byHost.b)&&byHost.b.length>=1&&byHost.b.every(l=>l.host_id===cl.b.host_id),`?host= returns host's listings (${byHost.b.length})`)
  // guest + FUTURE booking
  await req('POST','/api/auth/signup',null,{email:G,password:'Test12345',full_name:'AHR Guest',role:'user'})
  const gt=(await req('POST','/api/auth/verify-otp',null,{email:G,code:await otp(G)})).b.token
  const bk=await req('POST','/api/local/bookings',gt,{listing_id:lid,check_in:'2026-12-01',check_out:'2026-12-04',guests:2})
  const bid=bk.b.id
  // can't review yet (future, pending)
  chk((await req('POST','/api/local/reviews',gt,{booking_id:bid,rating:5,comment:'x'})).s===400,'cannot review before stay ended')
  // ADMIN drives lifecycle
  const at=(await req('POST','/api/auth/login',null,{email:'admin',password:ADMIN_PW})).b.token
  chk(!!at,'admin login')
  chk((await req('PATCH',`/api/local/admin/bookings/${bid}`,at,{status:'confirmed'})).b.status==='confirmed','admin set booked (confirmed)')
  chk((await req('PATCH',`/api/local/admin/bookings/${bid}`,at,{status:'completed'})).b.status==='completed','admin set stay-ended (completed)')
  chk((await req('PATCH',`/api/local/admin/bookings/${bid}`,at,{status:'banana'})).s===400,'admin invalid status -> 400')
  // now guest CAN review (stay ended), even though dates are future
  chk((await req('POST','/api/local/reviews',gt,{booking_id:bid,rating:5,comment:'Loved it!'})).s===201,'review unlocked after admin marked stay ended -> 201')
  const det=await req('GET',`/api/local/listings/${lid}`)
  chk(det.b.rating===5&&det.b.review_count===1,'listing now rating=5 count=1',`r=${det.b.rating} n=${det.b.review_count}`)
  await clean(); await pool.end()
  console.log(`\n${F===0?'✅ ALL '+P+' PASSED':'❌ '+F+' FAILED, '+P+' passed'}\n`); process.exit(F===0?0:1)
})().catch(async e=>{console.error('CRASHED:',e.message);try{await pool.end()}catch{};process.exit(1)})
