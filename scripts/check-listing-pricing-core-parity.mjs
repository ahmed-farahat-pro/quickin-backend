// Guards src/lib/local/listing-pricing-core.ts against drift between the two repos.
//
// This module holds the INPUT rules for the seasonal rungs of the ladder: what
// counts as a weekend rate, which days that rate is charged on, the per-month
// overrides and the two length-of-stay discounts. The web forms run it before
// they submit and the API runs it before it stores, which is the whole point —
// a host must not be told "saved" on the form and have the API quietly keep
// something else. If the copies drifted, the form and the door would disagree
// about the same field, which is exactly the class of silent drop these rules
// were written to end.
//
//   node quickin-backend/scripts/check-listing-pricing-core-parity.mjs
//
// Exits 1 on drift. Run it before deploying either project (npm run check does).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const FILES = {
  backend: new URL('../src/lib/local/listing-pricing-core.ts', import.meta.url),
  frontend: new URL('../../../quickin-frontend/src/lib/local/listing-pricing-core.ts', import.meta.url),
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
    const exports = [...be.matchAll(/export (?:function|const|class) (\w+)/g)].map((m) => m[1])
    console.log(`✅ listing-pricing-core is identical in both repos — ${exports.length} exports (${hash(be)})`)
    console.log(`   ${exports.join(', ')}`)
    process.exit(0)
  }

  console.error('❌ listing-pricing-core.ts has DRIFTED between the two repos')
  console.error(`   backend  ${hash(be)}  ${be.split('\n').length} lines`)
  console.error(`   frontend ${hash(fe)}  ${fe.split('\n').length} lines`)

  // Show the first differing line — enough to locate the edit without a full diff.
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
} catch (err) {
  console.error(`❌ listing-pricing-core parity check could not run: ${err.message}`)
  process.exit(1)
}
