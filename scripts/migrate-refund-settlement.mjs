// Refund settlement — the /ops queue that pays cancelled guests back.
//
// A cancellation already records what the guest is OWED (refund_percent /
// refund_amount, see migrate-cancellation.mjs). Nothing recorded whether anyone
// had actually sent it: there is no gateway, so a human makes the transfer. These
// three columns are that record.
//
//  - bookings.refunded_at    : when the money was actually sent. NULL = still due.
//  - bookings.refunded_by    : the staff account that marked it sent.
//  - bookings.refund_reference: the transfer reference the guest can be quoted.
//
// Deliberately separate from cancelled_at: the two are days apart, and reusing it
// would call every cancellation settled the moment it was made.
//
//   node quickin-backend/scripts/migrate-refund-settlement.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, '')
}
const _cs = dbUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })

const DDL = `
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_by text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reference text;

-- The queue reads exactly one shape: cancelled, money owed, not yet sent. A partial
-- index keeps it cheap as the cancelled pile grows, since a settled refund never
-- needs finding again.
CREATE INDEX IF NOT EXISTS bookings_refund_due_idx
  ON bookings (cancelled_at DESC)
  WHERE status = 'cancelled' AND refunded_at IS NULL AND COALESCE(refund_percent, 0) > 0;
`

;(async () => {
  await pool.query(DDL)
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'bookings'
        AND column_name IN ('refunded_at', 'refunded_by', 'refund_reference')`
  )
  const found = new Set(rows.map((r) => r.column_name))
  for (const c of ['refunded_at', 'refunded_by', 'refund_reference']) {
    console.log(`bookings.${c}:`, found.has(c) ? '✅' : '❌')
  }
  // What the queue will show on its first load, so the operator knows what they
  // inherited rather than being surprised by a backlog.
  const { rows: due } = await pool.query(
    `SELECT count(*)::int AS n, COALESCE(sum(refund_amount), 0)::float8 AS total
       FROM bookings
      WHERE status = 'cancelled' AND refunded_at IS NULL AND COALESCE(refund_percent, 0) > 0
        AND (payment_status = 'paid' OR paid_at IS NOT NULL)`
  )
  console.log(`refunds already due: ${due[0].n} (EGP ${due[0].total})`)
  await pool.end()
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
