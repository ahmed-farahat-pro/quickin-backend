// Guards src/lib/local/payment-flow-core.ts against drift between the two repos.
//
// This file decides where a booking sits in the payment flow (`paymentStageFor`,
// `canPay`) and, since the stay-pass fix, whether its pass is live at all
// (`isLiveStayPass`). The API enforces those, the website renders them, and iOS
// and Android carry hand-written translations of the same rules. If the two
// repos disagreed, a guest could be invited to pay twice — or, worse, hold a QR
// on one surface for a stay another surface still considers unpaid. Byte-
// identical, not merely equivalent.
//
// See README → "The stay pass waits for the money, not for the host".
//
//   node quickin-backend/scripts/check-payment-flow-core-parity.mjs
//
// Exits 1 on drift. Run it before deploying either project (npm run check does).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const FILES = {
  backend: new URL('../src/lib/local/payment-flow-core.ts', import.meta.url),
  frontend: new URL('../../../quickin-frontend/src/lib/local/payment-flow-core.ts', import.meta.url),
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
    console.log(`✅ payment-flow-core is identical in both repos — ${exports.length} exports (${hash(be)})`)
    console.log(`   ${exports.join(', ')}`)
    process.exit(0)
  }

  console.error('❌ payment-flow-core.ts has DRIFTED between the two repos')
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
