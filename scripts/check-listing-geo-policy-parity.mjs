// Guards src/lib/local/listing-geo-policy.ts against drift between the two repos.
//
// The web project renders the "this pin is outside Egypt" warning under the host
// form's map and badges an ignored one in /ops; this project answers the same
// verdict as `pin_warning` on POST/PATCH. If the boxes diverge, a host is warned
// on one surface and waved through on the other about the same coordinate — so
// this file must be byte-identical, not merely equivalent.
//
//   node quickin-backend/scripts/check-listing-geo-policy-parity.mjs
//
// Exits 1 on drift. Run it before deploying either project (npm run check does).
// The Swift translation (quickin-mono/mobile/ios/Sources/ListingGeoPolicy.swift)
// carries the same numbers but cannot be compared byte-for-byte — that project has
// no test target — so update it by hand whenever these boxes change.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const FILES = {
  backend: new URL('../src/lib/local/listing-geo-policy.ts', import.meta.url),
  frontend: new URL('../../../quickin-frontend/src/lib/local/listing-geo-policy.ts', import.meta.url),
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
    console.log(`✅ listing-geo-policy is identical in both repos — ${exports.length} exports (${hash(be)})`)
    console.log(`   ${exports.join(', ')}`)
    process.exit(0)
  }

  console.error('❌ listing-geo-policy.ts has DRIFTED between the two repos')
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
