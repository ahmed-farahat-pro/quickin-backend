// Verifies the new search engine live. Polls until the regions endpoint exists.
const B = process.env.BASE_URL || 'https://quickin-backend.vercel.app'
let P=0,F=0; const chk=(c,l,x='')=>{console.log(`${c?'  PASS':'  FAIL'} ${l}${x?'  ('+x+')':''}`);c?P++:F++}
const get=async(p)=>{const r=await fetch(B+p);return{s:r.status,b:await r.json().catch(()=>[])}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
;(async()=>{
  console.log(`\nSearch engine vs ${B}\n`)
  // wait for deploy: /regions must exist
  let reg, waited=0
  while(waited<180){ reg=await get('/api/local/regions'); if(reg.s===200 && Array.isArray(reg.b)) break; console.log(`  ...waiting for deploy ${waited}s`); await sleep(12); waited+=12 }
  chk(reg.s===200 && Array.isArray(reg.b), 'GET /api/local/regions', JSON.stringify(reg.b))

  const all=await get('/api/local/listings')
  chk(all.b.length>0, `all listings (${all.b.length})`)
  chk(all.b.every(l=>'region' in l), 'listings include region field')

  const nc=await get('/api/local/listings?region='+encodeURIComponent('North Coast'))
  chk(nc.b.every(l=>l.region==='North Coast'), `region=North Coast -> ${nc.b.length} (all North Coast)`)

  const sk=await get('/api/local/listings?q=sokhna')
  chk(sk.b.length>0 && sk.b.every(l=>/sokhna/i.test((l.title||'')+(l.location||'')+(l.region||''))), `q=sokhna -> ${sk.b.length}`)

  // free text matches REGION even if location text differs
  const ncq=await get('/api/local/listings?q='+encodeURIComponent('north coast'))
  chk(ncq.b.length>0, `q="north coast" -> ${ncq.b.length} (matches region)`)

  // search by NAME (title) now works (was location-only before)
  const byName=await get('/api/local/listings?q='+encodeURIComponent(all.b[0].title.split(' ')[0]))
  chk(byName.b.length>0, `q=name "${all.b[0].title.split(' ')[0]}" -> ${byName.b.length}`)

  // price sort
  const asc=await get('/api/local/listings?sort=price_asc')
  const sorted=asc.b.map(l=>l.price_per_night)
  chk(sorted.every((v,i)=>i===0||sorted[i-1]<=v), 'sort=price_asc ascending', sorted.join(','))

  // price range
  const cheap=await get('/api/local/listings?maxPrice=300')
  chk(cheap.b.every(l=>l.price_per_night<=300), `maxPrice=300 -> ${cheap.b.length} all <=300`)

  console.log(`\n${F===0?'✅ ALL '+P+' PASSED':'❌ '+F+' FAILED, '+P+' passed'}\n`)
  process.exit(F===0?0:1)
})().catch(e=>{console.error('CRASHED:',e.message);process.exit(1)})
