import { Pool } from 'pg'

// Single shared node-postgres pool. Works locally (TCP to local Postgres) AND on
// Vercel serverless (TCP to Vercel/Neon Postgres via DATABASE_URL). Replaces the
// old psql-CLI approach, which cannot run on serverless.
const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://ahmedfarahat@127.0.0.1:5432/quickin_local'

const isLocal =
  connectionString.includes('127.0.0.1') || connectionString.includes('localhost')

// Reuse the pool across hot-reloads / lambda invocations.
const g = globalThis as unknown as { _qkPool?: Pool }

export const pool: Pool =
  g._qkPool ??
  new Pool({
    connectionString,
    max: 5,
    // Managed Postgres (Neon/Vercel/RDS) needs TLS; local does not.
    ssl: isLocal ? false : { rejectUnauthorized: false },
  })

if (!g._qkPool) g._qkPool = pool

export async function query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params)
  return res.rows as T[]
}
