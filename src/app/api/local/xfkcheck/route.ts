// TEMP: list every FK that references users + its ON DELETE rule. Key-gated. REMOVE after.
import { NextResponse } from 'next/server'
import { pool } from '@/lib/local/pool'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const KEY = 'qk-fk-1a2b'
const RULE: Record<string, string> = { a: 'NO ACTION (BLOCKS)', r: 'RESTRICT (BLOCKS)', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }

export async function GET(req: Request) {
  const url = new URL(req.url)
  if (url.searchParams.get('key') !== KEY) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const ref = url.searchParams.get('ref') || 'users'
  const { rows } = await pool.query(`
    SELECT rel.relname AS tbl, con.conname,
      (SELECT string_agg(att.attname, ',') FROM unnest(con.conkey) k JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=k) AS cols,
      con.confdeltype
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_class frel ON frel.oid = con.confrelid
    WHERE con.contype='f' AND frel.relname=$1
    ORDER BY con.confdeltype, rel.relname`, [ref])
  const fks = rows.map((r: { tbl: string; cols: string; confdeltype: string; conname: string }) => ({ table: r.tbl, column: r.cols, constraint: r.conname, onDelete: RULE[r.confdeltype] || r.confdeltype }))
  return NextResponse.json({ blockers: fks.filter((f) => /BLOCKS/.test(f.onDelete)), all: fks })
}
