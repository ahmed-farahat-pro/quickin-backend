// Guards the one thing that MUST agree between the two repos: the staff module
// catalog. The web no longer has a staff.ts — it holds only the CATALOG, split out
// into src/lib/local/staff-modules.ts so the console can name a module without
// importing session code that talks to a database it no longer has. The two copies
// can still drift, so this guard still earns its place.
// quickin-backend and quickin-frontend each carry their own copy of
// src/lib/local/staff.ts (they share a Neon DB but cannot import each other), and
// staff_permissions.module rows are written by one and read by the other — so a
// drifted key means a moderator silently loses, or silently gains, a module.
//
//   node quickin-backend/scripts/check-staff-parity.mjs
//
// Exits 1 on drift. Run it before deploying either project.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const FILES = {
  backend: new URL('../src/lib/local/staff.ts', import.meta.url),
  frontend: new URL('../../../quickin-frontend/src/lib/local/staff-modules.ts', import.meta.url),
}

// Pull out just the STAFF_MODULES array literal, then strip comments and all
// whitespace so formatting differences don't register as drift.
function extractModules(path, label) {
  let src
  try {
    src = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read the ${label} copy at ${path.pathname}`)
  }
  const m = src.match(/export const STAFF_MODULES\s*=\s*\[([\s\S]*?)\n\]\s*as const/)
  if (!m) throw new Error(`STAFF_MODULES array not found in the ${label} copy`)
  const body = m[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '')
  const keys = [...m[1].matchAll(/key:\s*'([^']+)'/g)].map((x) => x[1])
  return { body, keys, hash: createHash('sha256').update(body).digest('hex').slice(0, 12) }
}

try {
  const be = extractModules(FILES.backend, 'backend')
  const fe = extractModules(FILES.frontend, 'frontend')

  if (be.body === fe.body) {
    console.log(`✅ staff module catalogs match — ${be.keys.length} modules (${be.hash})`)
    console.log(`   ${be.keys.join(', ')}`)
    process.exit(0)
  }

  console.error('❌ STAFF_MODULES has drifted between the two repos')
  console.error(`   backend  ${be.hash}  ${be.keys.length} modules`)
  console.error(`   frontend ${fe.hash}  ${fe.keys.length} modules`)
  const onlyBe = be.keys.filter((k) => !fe.keys.includes(k))
  const onlyFe = fe.keys.filter((k) => !be.keys.includes(k))
  if (onlyBe.length) console.error(`   only in backend:  ${onlyBe.join(', ')}`)
  if (onlyFe.length) console.error(`   only in frontend: ${onlyFe.join(', ')}`)
  if (!onlyBe.length && !onlyFe.length) {
    console.error('   same keys, differing labels/flags — reconcile the two files')
  }
  process.exit(1)
} catch (e) {
  console.error('PARITY CHECK FAILED:', e.message || e)
  process.exit(1)
}
