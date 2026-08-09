// Policy violations — the record behind /ops → Moderation.
//
// The content guard (src/lib/local/contentguard.ts) already refuses to store a
// message carrying a phone number, address, handle or off-platform link. Until
// now that refusal left no trace: someone could try forty times and nobody would
// know, and a novel obfuscation that got through was invisible by definition.
//
//  - policy_violations: one row per BLOCKED attempt. `body` is the full text the
//    user typed, on purpose — a count alone can't distinguish a determined evader
//    from someone whose booking reference tripped the guard, and the thing that
//    makes review possible is seeing what was actually written. It is behind the
//    `moderation` staff module and reading it is audited like any other /ops read.
//  - reviewed_at / reviewed_by: without these the alert count never drains and
//    becomes permanent noise. Warning, suspending or dismissing marks a user's
//    outstanding rows reviewed, exactly like reports' open → resolved/dismissed.
//  - policy_warnings: a warning a moderator issued. The user must ACKNOWLEDGE it
//    before they can send another message — enforced server-side, so an old app
//    build can't ignore it. acknowledged_at NULL = the gate is closed.
//
// No user-facing column changes, so this is additive and safe to apply ahead of
// the deploy that reads it.
//   node quickin-backend/scripts/migrate-policy-violations.mjs
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
CREATE TABLE IF NOT EXISTS policy_violations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the guard matched: 'phone' | 'email' | 'social' | 'url'.
  kind         text NOT NULL,
  -- Where they tried it: 'chat' | 'review' | 'listing' | 'profile'.
  surface      text NOT NULL,
  -- The full text of the attempt. See the note at the top of this file.
  body         text NOT NULL,
  -- True when the guard only caught this by stitching the sender's recent
  -- messages together — a deliberate drip-feed reads very differently from one
  -- careless message, and the moderation screen says so.
  split        boolean NOT NULL DEFAULT false,
  -- Which thread/listing it happened in, for the moderator's context. Free text
  -- rather than an FK because the referent differs by surface and a listing can
  -- be deleted without taking the evidence with it.
  context_type text,
  context_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz,
  reviewed_by  text
);

-- The moderation list: users with unreviewed rows, newest first.
CREATE INDEX IF NOT EXISTS policy_violations_open_idx
  ON policy_violations (user_id, created_at DESC) WHERE reviewed_at IS NULL;
-- One user's full history, reviewed or not.
CREATE INDEX IF NOT EXISTS policy_violations_user_idx
  ON policy_violations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_warnings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message         text NOT NULL,
  -- 'staff:<uuid>' — the same free-text actor convention as
  -- payment_proofs.reviewed_by and users.status_changed_by.
  issued_by       text NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

-- The gate is read on EVERY chat send, so it gets a partial index: only
-- unacknowledged rows are ever looked up, and there are very few of them.
CREATE INDEX IF NOT EXISTS policy_warnings_pending_idx
  ON policy_warnings (user_id) WHERE acknowledged_at IS NULL;
`

;(async () => {
  await pool.query(DDL)

  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('policy_violations', 'policy_warnings')`
  )
  const found = cols.rows.map((r) => `${r.table_name}.${r.column_name}`)
  const want = [
    'policy_violations.id', 'policy_violations.user_id', 'policy_violations.kind',
    'policy_violations.surface', 'policy_violations.body', 'policy_violations.split',
    'policy_violations.context_type', 'policy_violations.context_id',
    'policy_violations.created_at', 'policy_violations.reviewed_at', 'policy_violations.reviewed_by',
    'policy_warnings.id', 'policy_warnings.user_id', 'policy_warnings.message',
    'policy_warnings.issued_by', 'policy_warnings.issued_at', 'policy_warnings.acknowledged_at',
  ]
  for (const c of want) console.log(`${c}:`, found.includes(c) ? '✅' : '❌')

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename IN ('policy_violations', 'policy_warnings')`
  )
  console.log('indexes:', idx.rows.map((r) => r.indexname).join(', '))

  const n = await pool.query(
    `SELECT (SELECT COUNT(*) FROM policy_violations)::int AS violations,
            (SELECT COUNT(*) FROM policy_violations WHERE reviewed_at IS NULL)::int AS unreviewed,
            (SELECT COUNT(*) FROM policy_warnings WHERE acknowledged_at IS NULL)::int AS pending_warnings`
  )
  console.log('rows:', JSON.stringify(n.rows[0]))

  await pool.end()
  if (want.some((c) => !found.includes(c))) process.exit(1)
})().catch(async (e) => {
  console.error('migration failed:', e.message)
  try { await pool.end() } catch {}
  process.exit(1)
})
