// Two separate accounts per email: one 'user', one 'host'. Drop the unique(email)
// constraint and key uniqueness on (lower(email), role) instead. Idempotent.
import pg from 'pg'; import { readFileSync } from 'node:fs'
const env=readFileSync(new URL('../.env',import.meta.url),'utf8')
const DB=(process.env.DATABASE_URL||env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g,''))
const pool=new pg.Pool({connectionString:DB,ssl:{rejectUnauthorized:false}})
;(async()=>{
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key`)
  await pool.query(`DROP INDEX IF EXISTS users_email_key`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_role_uidx ON users (lower(email), role)`)
  const c=await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid='users'::regclass AND contype='u'`)
  const i=await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='users' AND indexname='users_email_role_uidx'`)
  console.log('remaining unique constraints:', c.rows.map(r=>r.conname).join(', ')||'(none)')
  console.log('email+role unique index:', i.rows.length? '✅ created':'❌ missing')
  await pool.end()
})().catch(async e=>{console.error('migration failed:',e.message);try{await pool.end()}catch{};process.exit(1)})
