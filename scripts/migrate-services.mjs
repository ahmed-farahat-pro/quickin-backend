// Adds the services + service_requests tables (a "booking system" for standalone
// experiences: host posts a service, user requests it, host accepts). Idempotent.
//   node quickin-backend/scripts/migrate-services.mjs
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
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A host offers a standalone experience (jet ski, diving, tour, …).
CREATE TABLE IF NOT EXISTS services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  category     text,
  location     text,
  price        numeric NOT NULL DEFAULT 0,
  currency     text DEFAULT 'USD',
  image_url    text,
  lat          double precision,
  lng          double precision,
  is_published boolean DEFAULT true,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_host ON services(host_id);

-- A user "subscribes"/requests a service; like a booking it goes pending -> confirmed/rejected.
CREATE TABLE IF NOT EXISTS service_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id     uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending',
  preferred_date date,
  note           text,
  request_code   text,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_requests_user ON service_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_service_requests_service ON service_requests(service_id);
`

const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } })
;(async () => {
  await pool.query(DDL)
  const { rows } = await pool.query(
    `select table_name from information_schema.tables where table_name in ('services','service_requests') order by table_name`
  )
  console.log('Tables present:', rows.map((r) => r.table_name).join(', ') || '(none)')
  await pool.end()
  console.log('✅ services migration applied')
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
