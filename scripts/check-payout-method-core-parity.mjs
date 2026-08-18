// Guards src/lib/local/payout-method-core.ts against drift between the two repos.
//
// Both projects read and write the same `host_payout_methods` rows, and both
// validate what a host submits. If the web accepted a card, address or wallet
// number the mobile API rejects (or vice-versa), a host would add a payout
// method on one surface that the other refuses to show — or worse, the two
// would disagree on what part of a card is safe to keep. So this file must be
// byte-identical, not merely equivalent.
//
//   node quickin-backend/scripts/check-payout-method-core-parity.mjs
//
// Exits 1 on drift. Run it before deploying either project (npm run check does).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const FILES = {
  backend: new URL('../src/lib/local/payout-method-core.ts', import.meta.url),
  frontend: new URL('../../../quickin-frontend/src/lib/local/payout-method-core.ts', import.meta.url),
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
    console.log(`✅ payout-method-core is identical in both repos — ${exports.length} exports (${hash(be)})`)
    console.log(`   ${exports.join(', ')}`)
    process.exit(0)
  }

  console.error('❌ payout-method-core.ts has DRIFTED between the two repos')
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
} catch (e) {
  console.error('PARITY CHECK FAILED:', e.message || e)
  process.exit(1)
}
