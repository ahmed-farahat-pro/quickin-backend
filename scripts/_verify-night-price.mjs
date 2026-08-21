// Proves the SQL nightly ladder and its TypeScript twin answer the same number.
//
//   DATABASE_URL='postgresql://localhost:5432/quickin_local' node scripts/_verify-night-price.mjs
//
// perNightSeasonalSql() is what the SERVER charges; resolveNightPrice() is what the
// clients PREVIEW. `npm run check` proves date-pricing-core.ts is identical across the
// two repos — it cannot prove these two rungs inside it agree with each other, and for
// a while they did not: each project had hand-written its own CASE, one ignoring
// `weekend_days` and the other missing the monthly rung entirely. Needs a database, so
// it is a script rather than a unit test.
import pg from 'pg'
import { perNightSeasonalSql, sqlWithDatePrice, resolveNightPrice } from '../src/lib/local/date-pricing-core.ts'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
const dates = ['2026-09-01','2026-09-04','2026-09-05','2026-09-06','2026-12-25','2026-07-10','2026-02-14']
const listings = [
  { base: 1000, weekend: null,  wdays: null,    monthly: {} },
  { base: 1000, weekend: 1500,  wdays: null,    monthly: {} },              // weekend_days NULL -> default Fri/Sat
  { base: 1000, weekend: 1500,  wdays: [],      monthly: {} },              // empty -> default
  { base: 1000, weekend: 1500,  wdays: [0,1],   monthly: {} },              // Sun/Mon weekend
  { base: 1000, weekend: null,  wdays: null,    monthly: {9:2000,12:3000} },// monthly rung only
  { base: 1000, weekend: 1500,  wdays: [5,6],   monthly: {9:2000} },        // weekend beats monthly
]
let bad = 0, n = 0
for (const L of listings) {
  for (const d of dates) {
    const { rows } = await pool.query(
      `SELECT (${perNightSeasonalSql('$1::date', 'l')})::float8 AS price
         FROM (SELECT $2::numeric AS price_per_night, $3::numeric AS weekend_price,
                      $4::int[] AS weekend_days, $5::jsonb AS monthly_prices) l`,
      [d, L.base, L.weekend, L.wdays, JSON.stringify(L.monthly)]
    )
    const sql = Number(rows[0].price)
    const ts = resolveNightPrice(d, {
      datePrices: {}, weekendPrice: L.weekend, weekendDays: L.wdays,
      monthlyPrices: Object.fromEntries(Object.entries(L.monthly).map(([k,v])=>[String(k),v])),
      basePrice: L.base,
    }).price
    n++
    if (Math.abs(sql - ts) > 1e-9) { bad++; console.log(`  MISMATCH ${d} wknd=${L.weekend} days=${JSON.stringify(L.wdays)} monthly=${JSON.stringify(L.monthly)} sql=${sql} ts=${ts}`) }
  }
}
console.log(bad === 0 ? `✅ SQL ladder matches resolveNightPrice on all ${n} cases` : `❌ ${bad}/${n} disagreed`)
await pool.end(); process.exit(bad ? 1 : 0)
