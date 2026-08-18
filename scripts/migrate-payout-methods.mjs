// Host payout methods — where QuickIn sends a host's earnings.
//   - host_payout_methods → one row per host, holding the single destination
//                           they chose (credit card / InstaPay / wallet).
//
// A host has exactly ONE preferred destination, so user_id is UNIQUE and the
// API upserts on it; changing method rewrites the row rather than adding one.
//
// Every method stores its destination WHOLE, because every one of them has to be
// payable: account_ref carries the IBAN (or the account number when there is no
// IBAN), the InstaPay address, or the wallet number.
//
//   node quickin-backend/scripts/migrate-payout-methods.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

const DDL = `
CREATE TABLE IF NOT EXISTS host_payout_methods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  method         text NOT NULL,              -- bank_account | instapay | wallet
  account_name   text NOT NULL,              -- the payee name a transfer must match
  account_ref    text NOT NULL,              -- IBAN (or account number) | InstaPay address | wallet number
  bank_name      text NOT NULL DEFAULT '',   -- bank only
  iban           text NOT NULL DEFAULT '',   -- bank only
  account_number text NOT NULL DEFAULT '',   -- bank only
  swift_bic      text NOT NULL DEFAULT '',   -- bank only, optional (international transfers)
  branch         text NOT NULL DEFAULT '',   -- bank only, optional
  provider       text NOT NULL DEFAULT '',   -- wallet provider; '' otherwise
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_host_payout_methods_method ON host_payout_methods (method);

-- Converge a database built by the FIRST version of this script, which had a
-- 'credit_card' method with an expiry instead of a bank account. That version
-- never reached production, so there is nothing to back-fill — but a local dev
-- database may already hold the old shape.
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS iban           text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS account_number text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS swift_bic      text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS branch         text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods ADD COLUMN IF NOT EXISTS bank_name      text NOT NULL DEFAULT '';
ALTER TABLE host_payout_methods DROP COLUMN IF EXISTS expiry;
`

const _cs = databaseUrl()
const _isLocal = _cs.includes('127.0.0.1') || _cs.includes('localhost')
const pool = new pg.Pool({ connectionString: _cs, ssl: _isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM host_payout_methods`)
  console.log(`✅ payout schema ready — host_payout_methods (${rows[0].n} rows)`)

  // The withdrawn 'credit_card' method. It never shipped, so this should always
  // be zero — say so loudly rather than silently if a row ever turns up, since
  // such a row is unpayable (it only ever held the last four digits).
  const stale = await pool.query(`SELECT count(*)::int AS n FROM host_payout_methods WHERE method = 'credit_card'`)
  if (stale.rows[0].n > 0) {
    console.log(`   ⚠️  ${stale.rows[0].n} row(s) still on the withdrawn 'credit_card' method — those hosts must re-add a bank account`)
  }

  // Blast radius: how many approved hosts still have nowhere to be paid. This is
  // reporting only — an incomplete payout method blocks nothing today.
  try {
    const gap = await pool.query(
      `SELECT count(*)::int AS n
         FROM users u
        WHERE (COALESCE(u.is_host, false) = true OR u.role = 'host')
          AND NOT EXISTS (SELECT 1 FROM host_payout_methods p WHERE p.user_id = u.id)`
    )
    console.log(`   ${gap.rows[0].n} host(s) have not added a payout method yet`)
  } catch (e) {
    console.log(`   (skipped the host gap count: ${e.message})`)
  }

  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
