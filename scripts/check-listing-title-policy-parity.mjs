// Guards src/lib/local/listing-title-policy.ts against drift between the two repos.
//
// A title is what a listing IS on the explore grid, in search, in the booking
// request a host gets. Both repos write titles into the SAME listings table —
// this project for the iOS and Android apps, the web project for /host/new and
// the host edit form — so a rule that lives in only one of them means `12345` is
// refused on the website and published from the phone, into the same grid.
//
//   node quickin-backend/scripts/check-listing-title-policy-parity.mjs
//
// Exits 1 on drift. Run it before deploying either project (npm run check does).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const FILES = {
  backend: new URL('../src/lib/local/listing-title-policy.ts', import.meta.url),
  frontend: new URL('../../../quickin-frontend/src/lib/local/listing-title-policy.ts', import.meta.url),
}

function read(url, label) {
  try {
    return readFileSync(url, 'utf8')
  } catch {
    throw new Error(
      `cannot read the ${label} copy at ${url.pathname}\n` +
      `   (this check assumes both repos are siblings under projects/quickin/)`
    )
  }
}

try {
  const be = read(FILES.backend, 'backend')
  const fe = read(FILES.frontend, 'frontend')
  const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)

  if (be === fe) {
    const exports = [...be.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1])
    console.log(`✅ listing-title-policy is identical in both repos — ${exports.length} exports (${hash(be)})`)
    console.log(`   ${exports.join(', ')}`)
    process.exit(0)
  }

  console.error('❌ listing-title-policy.ts has DRIFTED between the two repos')
  console.error(`   backend  ${hash(be)}  ${be.split('\n').length} lines`)
  console.error(`   frontend ${hash(fe)}  ${fe.split('\n').length} lines`)

  const b = be.split('\n')
  const f = fe.split('\n')
  for (let i = 0; i < Math.max(b.length, f.length); i++) {
    if (b[i] !== f[i]) {
      console.error(`\n   first difference at line ${i + 1}:`)
      console.error(`     backend : ${b[i] ?? '(end of file)'}`)
      console.error(`     frontend: ${f[i] ?? '(end of file)'}`)
      break
    }
  }
  console.error('\n   Fix: edit one copy, then copy it over the other verbatim.')
  process.exit(1)
} catch (e) {
  console.error('PARITY CHECK FAILED:', e.message || e)
  process.exit(1)
}
