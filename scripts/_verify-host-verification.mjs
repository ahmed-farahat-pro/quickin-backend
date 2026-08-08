// Exercises the host verification gate against a real database: the gate rule,
// the revocation unpublish, and the restore-on-reverify — including how it
// composes with an account block, which is the part unit tests can't reach.
//
// LOCAL ONLY. It creates and deletes fixture users and listings, so it refuses a
// remote DATABASE_URL.
//   node quickin-backend/scripts/_verify-host-verification.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { canPublishListing, revokesListingPrivileges } from '../src/lib/local/host-verification-core.ts'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const cs = process.env.DATABASE_URL || env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
if (!cs.includes('127.0.0.1') && !cs.includes('localhost')) {
  console.error('REFUSING TO RUN: this script writes fixture rows and DATABASE_URL is not local.')
  process.exit(1)
}
const pool = new pg.Pool({ connectionString: cs, ssl: false })

let failures = 0
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const TAG = '__HOSTVERIF_FIXTURE__'
const cleanup = async () => {
  await pool.query(`DELETE FROM listings WHERE title = $1`, [TAG])
  await pool.query(`DELETE FROM users WHERE email LIKE '__hostverif_%@fixture.test'`)
}
await cleanup()

// ---- 1. The gate rule against every real (is_host, verification_status) combo --
console.log('\n--- the gate, over every combination ---')
const combos = []
for (const isHost of [true, false]) {
  for (const vs of ['unverified', 'pending', 'verified', 'rejected']) combos.push({ isHost, vs })
}
const rows = []
for (const c of combos) {
  const email = `__hostverif_${c.isHost ? 'h' : 'g'}_${c.vs}@fixture.test`
  const { rows: u } = await pool.query(
    `INSERT INTO users (email, full_name, is_host, verification_status)
     VALUES ($1, 'Fixture', $2, $3) RETURNING id`,
    [email, c.isHost, c.vs]
  )
  rows.push({ ...c, id: u[0].id })
}

let bad = []
for (const r of rows) {
  // Read it back exactly as getListingGateState does.
  const { rows: g } = await pool.query(
    `SELECT (COALESCE(is_host, false) = true OR role = 'host') AS is_host,
            COALESCE(verification_status, 'unverified') AS verification_status
       FROM users WHERE id = $1`,
    [r.id]
  )
  const gate = canPublishListing({ isHost: g[0].is_host, verificationStatus: g[0].verification_status })
  const shouldAllow = r.isHost && r.vs === 'verified'
  if (gate.allowed !== shouldAllow) bad.push(`host=${r.isHost} ${r.vs}: allowed=${gate.allowed} want=${shouldAllow}`)
  console.log(`   is_host=${String(r.isHost).padEnd(5)} ${r.vs.padEnd(10)} → ${gate.allowed ? 'ALLOWED' : 'blocked (' + gate.code + ')'}`)
}
ok('exactly one combination may list: approved host AND verified', bad.length === 0, bad.join(' | '))

// ---- 2. role='host' alone is enough (the mobile backend's column) -------------
const { rows: legacy } = await pool.query(
  `INSERT INTO users (email, full_name, is_host, role, verification_status)
   VALUES ('__hostverif_legacy@fixture.test', 'Fixture', false, 'host', 'verified') RETURNING id`
)
const { rows: lg } = await pool.query(
  `SELECT (COALESCE(is_host, false) = true OR role = 'host') AS is_host,
          COALESCE(verification_status,'unverified') AS verification_status FROM users WHERE id = $1`,
  [legacy[0].id]
)
ok(
  'a host approved via role=\'host\' (mobile backend) is recognised',
  canPublishListing({ isHost: lg[0].is_host, verificationStatus: lg[0].verification_status }).allowed
)

// ---- 3. Revocation unpublishes; re-verifying restores ------------------------
console.log('\n--- revocation and restore ---')
const host = rows.find((r) => r.isHost && r.vs === 'verified')
const mk = async (published) => {
  const { rows: l } = await pool.query(
    `INSERT INTO listings (host_id, title, description, location, region, country, price_per_night,
                           currency, max_guests, property_type, is_published, approval_status)
     VALUES ($1, $2, 'temp', 'North Coast', 'North Coast', 'EG', 1000, 'EGP', 2, 'Chalet', $3, 'approved')
     RETURNING id`,
    [host.id, TAG, published]
  )
  return l[0].id
}
const liveId = await mk(true)
const draftId = await mk(false) // never published — must NOT be swept up

const revokeSql = async (prev, next) => {
  if (!revokesListingPrivileges(prev, next)) return 0
  const r = await pool.query(
    `UPDATE listings SET is_published = false, unpublished_by_verification = true
      WHERE host_id = $1 AND is_published = true`,
    [host.id]
  )
  return r.rowCount
}
const restoreSql = async () => {
  const r = await pool.query(
    `UPDATE listings SET is_published = true, unpublished_by_verification = false
      WHERE host_id = $1 AND unpublished_by_verification = true
        AND COALESCE(unpublished_by_admin, false) = false`,
    [host.id]
  )
  return r.rowCount
}
const stateOf = async (id) => {
  const { rows: l } = await pool.query(
    `SELECT is_published, unpublished_by_verification, unpublished_by_admin FROM listings WHERE id = $1`,
    [id]
  )
  return l[0]
}

const hidden = await revokeSql('verified', 'rejected')
ok('revoking verification unpublishes the live listing', (await stateOf(liveId)).is_published === false, `hid ${hidden}`)
ok('an unpublished draft is NOT flagged (so a restore cannot publish it)',
  (await stateOf(draftId)).unpublished_by_verification === false)

const restored = await restoreSql()
ok('re-verifying republishes exactly what verification hid', (await stateOf(liveId)).is_published === true, `restored ${restored}`)
ok('the draft is still unpublished after the restore', (await stateOf(draftId)).is_published === false)

// ---- 4. Composition with an account block ------------------------------------
console.log('\n--- composed with an account block ---')
await revokeSql('verified', 'rejected')
await pool.query(
  `UPDATE listings SET unpublished_by_admin = true WHERE id = $1`, [liveId]
) // now hidden for BOTH reasons
const restoredWhileBlocked = await restoreSql()
ok(
  're-verifying does NOT republish a listing that is also blocked',
  (await stateOf(liveId)).is_published === false,
  `restored ${restoredWhileBlocked} (want 0)`
)
// And the block-restore must not republish it while still unverified.
const unblock = await pool.query(
  `UPDATE listings SET is_published = true, unpublished_by_admin = false
    WHERE host_id = $1 AND unpublished_by_admin = true
      AND COALESCE(unpublished_by_verification, false) = false`,
  [host.id]
)
ok(
  'unblocking the account does NOT republish a listing verification hid',
  (await stateOf(liveId)).is_published === false,
  `republished ${unblock.rowCount} (want 0)`
)

// ---- 5. Publish gate: an unverified host's listing must not be approvable ----
console.log('\n--- publish gate ---')
// A listing owned by a host who is NOT verified — the case setListingApproval refuses.
const unverifiedHost = rows.find((r) => r.isHost && r.vs === 'rejected')
const { rows: ul } = await pool.query(
  `INSERT INTO listings (host_id, title, description, location, region, country, price_per_night,
                         currency, max_guests, property_type, is_published, approval_status)
   VALUES ($1, $2, 'temp', 'North Coast', 'North Coast', 'EG', 1000, 'EGP', 2, 'Chalet', false, 'pending')
   RETURNING id`,
  [unverifiedHost.id, TAG]
)
const { rows: hv } = await pool.query(
  `SELECT COALESCE(u.verification_status,'unverified') AS status
     FROM listings l JOIN users u ON u.id = l.host_id WHERE l.id = $1`,
  [ul[0].id]
)
ok('setListingApproval can read the host status it refuses on', hv[0]?.status === 'rejected', `got ${hv[0]?.status}`)
ok('and that host is indeed blocked by the gate',
  !canPublishListing({ isHost: true, verificationStatus: hv[0].status }).allowed)

await cleanup()
console.log('\n(fixture rows removed)')
console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
await pool.end()
process.exit(failures === 0 ? 0 : 1)
