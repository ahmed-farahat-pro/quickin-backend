// TEMPORARY migration: stay pass + host-authored stay guide. Idempotent. Key-gated. REMOVE after run.
//   1. stay_guide_items (+ index)  — host content attached to a confirmed booking.
//   2. bookings.reservation_code   — the column, then a BACKFILL: already-confirmed
//      (or completed) bookings whose code is NULL get one in the canonical format
//      "QK-" + 6 chars from the no-ambiguous-glyphs alphabet. PENDING bookings are
//      left NULL on purpose — no code, no QR, until they are confirmed.
//   3. a partial unique index on upper(reservation_code), so a code resolves to
//      exactly one stay (only created when the data is already free of duplicates).
import { NextResponse } from 'next/server'
import { pool } from '@/lib/local/pool'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const KEY = 'qk-mig6-2b81'

// Same alphabet + shape as genReservationCode() in src/lib/local/db.ts: "QK-" + 6
// chars, no ambiguous glyphs. Written as six inline picks rather than an aggregate
// over generate_series ON PURPOSE — an UNcorrelated sub-select would be planned as
// an InitPlan, evaluated ONCE, and every backfilled row would get the same code.
// random() in a plain target-list expression is volatile → re-rolled per row.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const RAND_CHAR = `substr('${ALPHABET}', 1 + floor(random() * ${ALPHABET.length})::int, 1)`
const NEW_CODE = `('QK-' || ${Array.from({ length: 6 }, () => RAND_CHAR).join(' || ')})`

// Codes belong to stays that are actually booked. 'completed' is included because
// a finished stay was necessarily approved at some point.
const CONFIRMED = `b.status IN ('confirmed', 'completed')`

const BACKFILL = `UPDATE bookings b SET reservation_code = ${NEW_CODE}
                   WHERE b.reservation_code IS NULL AND ${CONFIRMED}`

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get('key') !== KEY) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const steps: string[] = []
  const run = async (label: string, sql: string) => {
    try { await pool.query(sql); steps.push('ok: ' + label) } catch (e) { steps.push('ERR ' + label + ': ' + (e as Error).message) }
  }
  const count = async (sql: string): Promise<number> => {
    try { return (await pool.query(sql)).rows[0]?.n ?? -1 } catch { return -1 }
  }

  await run('create stay_guide_items', `
    CREATE TABLE IF NOT EXISTS stay_guide_items (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      kind        text NOT NULL,
      title       text,
      body        text,
      url         text,
      "order"     int DEFAULT 0,
      created_at  timestamptz DEFAULT now()
    )`)
  await run('index stay_guide_items', `CREATE INDEX IF NOT EXISTS idx_stay_guide_booking ON stay_guide_items(booking_id, "order")`)
  await run('add bookings.reservation_code', `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reservation_code text`)

  // Backfill. Retried a few times so an (astronomically unlikely) self-collision
  // re-rolls instead of leaving a row without a code.
  let backfilled = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    const remaining = await count(`SELECT count(*)::int AS n FROM bookings b WHERE b.reservation_code IS NULL AND ${CONFIRMED}`)
    if (remaining <= 0) break
    try {
      const r = await pool.query(BACKFILL)
      backfilled += r.rowCount ?? 0
    } catch (e) {
      steps.push('ERR backfill attempt ' + (attempt + 1) + ': ' + (e as Error).message)
    }
  }
  steps.push(`ok: backfilled ${backfilled} confirmed booking(s)`)

  const duplicates = await count(
    `SELECT count(*)::int AS n FROM (
       SELECT upper(reservation_code) FROM bookings WHERE reservation_code IS NOT NULL
        GROUP BY 1 HAVING count(*) > 1) d`
  )
  if (duplicates === 0) {
    await run('unique index on reservation_code', `
      CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_reservation_code
        ON bookings (upper(reservation_code)) WHERE reservation_code IS NOT NULL`)
  } else {
    steps.push(`skipped: unique index — ${duplicates} duplicate code(s) in the table`)
  }

  return NextResponse.json({
    ok: true,
    steps,
    backfilled,
    duplicate_codes: duplicates,
    // Sanity: nothing confirmed should be left without a code, and pending
    // bookings should ALL still be NULL (that is the rule, not a gap).
    confirmed_without_code: await count(`SELECT count(*)::int AS n FROM bookings b WHERE b.reservation_code IS NULL AND ${CONFIRMED}`),
    pending_without_code: await count(`SELECT count(*)::int AS n FROM bookings b WHERE b.reservation_code IS NULL AND b.status = 'pending'`),
    stay_guide_items_present: await count(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'stay_guide_items'`),
  })
}
