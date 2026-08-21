// Smoke-test the /ops data layer ported from quickin-frontend: every function is
// called against a real database so a bad SQL port fails here, not in the console.
import pg from 'pg'
const cs = process.env.DATABASE_URL
const pool = new pg.Pool({ connectionString: cs, ssl: cs.includes('localhost') ? false : { rejectUnauthorized: false } })
process.env.DATABASE_URL = cs
const db = await import('../src/lib/local/db.ts')
const mod = await import('../src/lib/local/moderation.ts')
const dis = await import('../src/lib/local/disputes.ts')
const idc = await import('../src/lib/local/id-changes.ts')
const ua  = await import('../src/lib/local/user-admin-core.ts')
const ac  = await import('../src/lib/local/activity-core.ts')

const cases = [
  ['adminStats',                 () => db.adminStats()],
  ['adminSearchUsers',           () => db.adminSearchUsers(ua.parseUserListFilter(() => null))],
  ['adminListListings',          () => db.adminListListings({})],
  ['adminListBookings',          () => db.adminListBookings({})],
  ['adminListPendingBookings',   () => db.adminListPendingBookings()],
  ['adminListReports',           () => db.adminListReports({})],
  ['adminListPendingProofs',     () => db.adminListPendingProofs()],
  ['getPendingHostApplications', () => db.getPendingHostApplications()],
  ['getPendingVerifications',    () => db.getPendingVerifications({})],
  ['getActivityFeed',            () => db.getActivityFeed(ac.parseActivityFilter(() => null))],
  ['getAuditLog',                () => db.getAuditLog(ac.parseAuditFilter(() => null))],
  ['getAuditActions',            () => db.getAuditActions()],
  ['getAppLinks',                () => db.getAppLinks()],
  ['getCommissionImpact',        () => db.getCommissionImpact()],
  ['adminStatTrends',            () => db.adminStatTrends('30d')],
  ['listStaffAccounts',          () => db.listStaffAccounts()],
  ['countFlaggedUsers',          () => mod.countFlaggedUsers()],
  ['adminListFlaggedUsers',      () => mod.adminListFlaggedUsers({})],
  ['countOpenDisputes',          () => dis.countOpenDisputes()],
  ['adminListDisputes',          () => dis.adminListDisputes({})],
  ['countPendingIdChanges',      () => idc.countPendingIdChanges()],
  ['adminListIdChangeRequests',  () => idc.adminListIdChangeRequests({})],
]
let ok = 0, bad = []
for (const [name, fn] of cases) {
  try { await fn(); ok++ }
  catch (e) { bad.push(`${name}: ${String(e.message).split('\n')[0]}`) }
}
console.log(`\n  ${ok}/${cases.length} ported /ops functions executed against a real database`)
if (bad.length) { console.log('\n  FAILURES:'); bad.forEach(b => console.log('   ✗ ' + b)) }
await pool.end()
process.exit(bad.length ? 1 : 0)
