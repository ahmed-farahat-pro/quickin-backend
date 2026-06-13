// Verifies the NEW rule: a verified guest registering "as a host" must confirm a
// fresh OTP (no instant upgrade). Polls until the new deploy is live, then asserts.
import pg from 'pg'
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const DB = (process.env.DATABASE_URL || env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,''))
const B = process.env.BASE_URL || 'https://quickin-backend.vercel.app'
const pool = new pg.Pool({ connectionString: DB, ssl:{rejectUnauthorized:false} })
let P=0,F=0; const chk=(c,l)=>{console.log(`${c?'  PASS':'  FAIL'} ${l}`);c?P++:F++}
const req=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:`Bearer ${t}`}:{})},body:b?JSON.stringify(b):undefined});return{s:r.status,b:await r.json().catch(()=>({}))}}
const otp=async e=>(await pool.query('select otp_code,pending_role,role from users where lower(email)=lower($1)',[e])).rows[0]
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const em='hostotp.test@problem-x.com'
async function clean(){await pool.query('delete from listings where host_id in (select id from users where email=$1)',[em]);await pool.query('delete from users where email=$1',[em])}

;(async()=>{
  console.log(`\nHost-OTP flow vs ${B}\n`)
  await clean()
  // 1) guest signup + verify
  await req('POST','/api/auth/signup',null,{email:em,password:'Guest12345',full_name:'OTP Tester',role:'user'})
  let tok=(await req('POST','/api/auth/verify-otp',null,{email:em,code:(await otp(em)).otp_code})).b.token
  chk(!!tok,'guest signup + OTP verify -> token')
  chk((await otp(em)).role==='user','account role = user after guest signup')

  // 2) register SAME email as host — wait for the new deploy, then assert pending (not instant upgrade)
  let r, waited=0
  while (waited<180){ r=await req('POST','/api/auth/signup',null,{email:em,password:'ignored123',full_name:'OTP Tester',role:'host'})
    if (r.b.pending && r.b.addingHost) break
    if (r.b.upgraded){ console.log(`  ...old deploy still live (got upgraded), waiting ${waited}s`); await sleep(12); waited+=12; continue }
    break }
  chk(r.b.pending===true && r.b.addingHost===true, `host registration returns pending+OTP (not instant upgrade)`)
  const row=await otp(em)
  chk(row.pending_role==='host','pending_role stashed = host')
  chk(row.role==='user','role still user until OTP confirmed (no early upgrade)')

  // 3) confirm the host OTP -> role becomes host
  const vr=await req('POST','/api/auth/verify-otp',null,{email:em,code:row.otp_code})
  chk(vr.s===200 && vr.b.user?.role==='host','verify host OTP -> role host + token')
  chk((await otp(em)).role==='host' && !(await otp(em)).pending_role,'DB role=host, pending_role cleared')

  // 4) dual role: can still sign in as guest, and as host
  chk((await req('POST','/api/auth/login',null,{email:em,password:'Guest12345',role:'host'})).b.user?.role==='host','login as host works')
  chk((await req('POST','/api/auth/login',null,{email:em,password:'Guest12345',role:'user'})).b.user?.role==='user','can still sign in as guest (dual role)')

  await clean(); await pool.end()
  console.log(`\n${F===0?'✅ ALL '+P+' PASSED':'❌ '+F+' FAILED, '+P+' passed'}\n`)
  process.exit(F===0?0:1)
})().catch(async e=>{console.error('CRASHED:',e.message);try{await pool.end()}catch{};process.exit(1)})
