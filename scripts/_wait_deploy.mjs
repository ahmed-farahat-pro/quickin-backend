// Poll the live backend until the hardened chat guard is deployed: the
// sentence-embedded split ("reach me 0100" + "1234567 anytime") must return 400.
import pg from 'pg'; import { readFileSync } from 'node:fs'
const BASE='https://quickin-backend.vercel.app'
const env=readFileSync(new URL('../.env',import.meta.url),'utf8')
const url=env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,'')
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false}})
const J=(p,b,t,m='POST')=>fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:`Bearer ${t}`}:{})},body:b?JSON.stringify(b):undefined}).then(async r=>({s:r.status,b:await r.json().catch(()=>({}))}))
const G=(p,t)=>fetch(BASE+p,{headers:t?{Authorization:`Bearer ${t}`}:{}}).then(async r=>({s:r.status,b:await r.json().catch(()=>({}))}))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))

const tok=(await J('/api/auth/login',{email:'guest.layla@demo.quickin.app',password:'Demo12345'})).b.token
const ls=await G('/api/local/listings'); const sahel=ls.b.find(x=>x.title==='Sahel Beach Villa')||ls.b[0]
let mon=1, deployed=false
for(let i=0;i<18;i++){
  const ci=`2036-${String(mon).padStart(2,'0')}-10`, co=`2036-${String(mon).padStart(2,'0')}-12`; mon++
  const bk=await J('/api/local/bookings',{listing_id:sahel.id,check_in:ci,check_out:co,guests:2},tok)
  const id=bk.b?.id
  if(id){
    await J(`/api/local/bookings/${id}/messages`,{body:'you can reach me at 0100'},tok)
    const r=await J(`/api/local/bookings/${id}/messages`,{body:'1234567 anytime'},tok)
    await pool.query('delete from bookings where id=$1',[id]).catch(()=>{})
    console.log(`attempt ${i+1}: split part2 → HTTP ${r.s}`)
    if(r.s===400){ deployed=true; break }
  } else { console.log(`attempt ${i+1}: booking failed (${bk.s})`) }
  await sleep(20000)
}
console.log(deployed?'DEPLOYED ✓ (guard live)':'TIMED OUT (still old guard)')
await pool.end()
process.exit(deployed?0:2)
