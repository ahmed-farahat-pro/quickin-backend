// Guest disputes — a guest raising an issue about a stay, routed to /ops for
// investigation and resolution.
//
// Deliberately NOT the two things that already exist:
//   • payment_proofs.status='disputed' is narrow — "the host rejected my proof
//     and I did pay" — and hangs off one payment proof's accept/reject lifecycle.
//   • reports is about a listing / user / review, with no booking target, no
//     attachments and a three-state lifecycle. Bending it to fit would change the
//     vocabulary the /ops → Reports screen filters on and mix stay disputes into
//     the abuse queue.
//
//  - disputes: one per issue raised. `photos` follows the convention already used
//    by payment_proofs.image_data and reviews.photos — base64 data-URLs inline in
//    Postgres, no object store. `resolution` is what the admin concluded, shown
//    back to the guest.
//  - dispute_events: the history. One row when it is filed, one for every status
//    change after that, each with the actor and an optional note. Nothing is
//    overwritten, so "who moved this to Resolved, when, and why" always has an
//    answer — the acceptance criterion is that all dispute history is stored.
//
// Additive only, so it is safe to apply ahead of the deploy that reads it.
//   node quickin-backend/scripts/migrate-disputes.mjs
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
CREATE TABLE IF NOT EXISTS disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- Denormalised from the booking so a dispute can still be attributed if the
  -- booking row is ever reshaped, and so "this guest's disputes" is one index.
  guest_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- One of DISPUTE_CATEGORIES in src/lib/local/disputes-core.ts. Plain text
  -- rather than an enum: the list lives in code (both projects share it), and a
  -- CHECK here would need a migration every time it changed.
  category     text NOT NULL,
  description  text NOT NULL,
  -- base64 data-URLs, same convention as payment_proofs.image_data.
  photos       text[] NOT NULL DEFAULT '{}',
  -- open | in_review | resolved | closed
  status       text NOT NULL DEFAULT 'open',
  -- What the admin concluded. Shown back to the guest, so it is not an internal note.
  resolution   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

-- The /ops queue: everything still needing a decision, newest first.
CREATE INDEX IF NOT EXISTS disputes_open_idx
  ON disputes (created_at DESC) WHERE status IN ('open', 'in_review');
-- "My disputes" on the guest's reservations screen.
CREATE INDEX IF NOT EXISTS disputes_guest_idx ON disputes (guest_id, created_at DESC);
-- "Does this booking already have a dispute?" — checked before offering the form.
CREATE INDEX IF NOT EXISTS disputes_booking_idx ON disputes (booking_id);

CREATE TABLE IF NOT EXISTS dispute_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  -- NULL on the filing row: it came from nowhere.
  from_status text,
  to_status   text NOT NULL,
  note        text,
  -- 'guest:<uuid>' or 'staff:<uuid>' — the same free-text actor convention as
  -- payment_proofs.reviewed_by and users.status_changed_by.
  actor       text NOT NULL,
  -- Snapshotted so the timeline still reads correctly after a staff account is
  -- renamed or deactivated.
  actor_name  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispute_events_dispute_idx ON dispute_events (dispute_id, created_at);
`

;(async () => {
  await pool.query(DDL)

  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('disputes', 'dispute_events')`
  )
  const found = cols.rows.map((r) => `${r.table_name}.${r.column_name}`)
  const want = [
    'disputes.id', 'disputes.booking_id', 'disputes.guest_id', 'disputes.category',
    'disputes.description', 'disputes.photos', 'disputes.status', 'disputes.resolution',
    'disputes.created_at', 'disputes.updated_at', 'disputes.resolved_at',
    'dispute_events.id', 'dispute_events.dispute_id', 'dispute_events.from_status',
    'dispute_events.to_status', 'dispute_events.note', 'dispute_events.actor',
    'dispute_events.actor_name', 'dispute_events.created_at',
  ]
  for (const c of want) console.log(`${c}:`, found.includes(c) ? '✅' : '❌')

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename IN ('disputes', 'dispute_events')`
  )
  console.log('indexes:', idx.rows.map((r) => r.indexname).join(', '))

  const n = await pool.query(
    `SELECT (SELECT COUNT(*) FROM disputes)::int AS disputes,
            (SELECT COUNT(*) FROM disputes WHERE status IN ('open','in_review'))::int AS needing_action,
            (SELECT COUNT(*) FROM dispute_events)::int AS events`
  )
  console.log('rows:', JSON.stringify(n.rows[0]))

  await pool.end()
  if (want.some((c) => !found.includes(c))) process.exit(1)
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
