// ID change requests — the review queue that replaces the freely-editable identity
// number on the mobile Edit Profile screen.
//
// `users.id_document` was a plain text field any signed-in user could PATCH over at
// will, reviewed by nobody and read by nothing. It is now read-only on every client,
// and changing it means filing a request here with a photo of the document, which an
// operator approves or rejects in /ops → ID verifications.
//
// Deliberately NOT folded into id_verifications, even though the same operator
// reviews both:
//   • That table's status column IS `users.verification_status` — reviewVerification
//     writes it straight through, and a 'rejected' row there unpublishes a host's
//     listings via the publish gate. A rejected *number correction* must not have
//     that blast radius.
//   • Its rows are the evidence a verification decision was made. Reusing them for a
//     second, differently-shaped decision would make "when was this user verified"
//     unanswerable from the table that is supposed to answer it.
//
// The approved value lands in users.id_document; the request row stays as the record
// of who approved what and when.
//
// Additive only, so it is safe to apply ahead of the deploy that reads it. Until it
// runs, the endpoints answer 500 and the /ops queue shows empty — nothing else
// regresses, because the field is read-only on the clients either way.
//   node quickin-backend/scripts/migrate-id-change-requests.mjs
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
CREATE TABLE IF NOT EXISTS id_change_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- users.id_document as it stood when the request was filed. Snapshotted so the
  -- reviewer sees the actual before/after even if the column is changed by another
  -- approval in between, and so the audit trail survives the value being overwritten.
  current_value   text,
  requested_value text NOT NULL,
  -- One of DOC_TYPES in src/lib/local/host-verification-core.ts
  -- (national_id | passport | residence_permit). Plain text rather than an enum:
  -- the list lives in code that both projects share, and a CHECK here would need a
  -- migration every time it changed — the same call id_verifications.doc_type made.
  doc_type        text NOT NULL DEFAULT 'national_id',
  -- FRONT of the document, REQUIRED. Without it a reviewer has nothing to check the
  -- typed number against, and approving would be rubber-stamping — which is the very
  -- thing this queue exists to stop. base64 data-URLs inline, the same convention as
  -- id_verifications.image_data.
  image_data      text NOT NULL,
  back_image_data text,
  -- The user's own explanation of the correction, optional.
  reason          text,
  -- pending | approved | rejected. See ID_CHANGE_STATUSES in id-change-core.ts.
  status          text NOT NULL DEFAULT 'pending',
  -- The operator's note. On a rejection this is the reason the user is shown, so it
  -- is not an internal-only field.
  notes           text,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     text
);

-- The /ops queue: everything awaiting a decision, oldest first so the alert centre's
-- "waited 3 days" and the review order agree.
CREATE INDEX IF NOT EXISTS id_change_requests_pending_idx
  ON id_change_requests (submitted_at) WHERE status = 'pending';
-- "My request" on the profile screen, and this user's history in /ops.
CREATE INDEX IF NOT EXISTS id_change_requests_user_idx
  ON id_change_requests (user_id, submitted_at DESC);
-- ONE open request per user, enforced by the database rather than by a read-then-write
-- in the route: two taps on a slow connection would otherwise file two requests, and an
-- operator would approve one identity while the other still claimed a different number.
CREATE UNIQUE INDEX IF NOT EXISTS id_change_requests_one_pending_per_user
  ON id_change_requests (user_id) WHERE status = 'pending';
`

;(async () => {
  await pool.query(DDL)

  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'id_change_requests'`
  )
  const found = cols.rows.map((r) => r.column_name)
  const want = [
    'id', 'user_id', 'current_value', 'requested_value', 'doc_type', 'image_data',
    'back_image_data', 'reason', 'status', 'notes', 'submitted_at', 'reviewed_at', 'reviewed_by',
  ]
  for (const c of want) console.log(`id_change_requests.${c}:`, found.includes(c) ? '✅' : '❌')

  const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'id_change_requests'`)
  console.log('indexes:', idx.rows.map((r) => r.indexname).join(', '))

  // The blast radius of the cutover: how many accounts already carry a self-declared
  // number that nobody ever reviewed. They keep it — approving them retroactively is
  // not something this migration can decide — but it is worth knowing the size.
  const n = await pool.query(
    `SELECT (SELECT COUNT(*) FROM id_change_requests)::int AS requests,
            (SELECT COUNT(*) FROM id_change_requests WHERE status = 'pending')::int AS pending,
            (SELECT COUNT(*) FROM users WHERE COALESCE(id_document, '') <> '')::int AS users_with_unreviewed_id`
  )
  console.log('rows:', JSON.stringify(n.rows[0]))

  await pool.end()
  if (want.some((c) => !found.includes(c))) process.exit(1)
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
