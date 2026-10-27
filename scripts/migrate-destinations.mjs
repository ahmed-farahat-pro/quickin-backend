// Destinations — turns the resorts catalog into the explore "region rail"
// taxonomy: 12 regions, each with its sub-areas (a sub-area IS a resort row).
// See src/lib/local/destinations-core.ts for the model and the 2026-10-22 brief
// ("Destinations: regions and sub-areas") for where the list came from.
//
//   1. Adds display columns to resorts: name_ar, km_marker, location_note, sort_order.
//   2. Upserts the business owner's sub-area list. A row whose slug already exists
//      (Marassi, Porto Sokhna, …) only gets the NEW columns filled — its name and
//      region are never overwritten, an admin may have corrected them.
//   3. The same name in two regions (Lasirena ×3, El Shorouk ×2) gets a region-
//      suffixed slug ('lasirena-ain-sokhna'): resorts.slug is globally unique and
//      resolveResortSelection() knows to prefer the host's region.
//   4. Old starter-seed resorts that aren't in the list are kept if any listing
//      points at them, deactivated (hidden from the host dropdown) if none does.
//
// Requires migrate-resorts.mjs first. Idempotent — safe to re-run, safe on prod.
// Until it runs, GET /api/local/destinations degrades to names only (no 500).
//   node quickin-backend/scripts/migrate-destinations.mjs
import pg from 'pg'
import { readFileSync } from 'node:fs'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not set and not found in quickin-backend/.env')
  return m[1].trim().replace(/^["']|["']$/g, '')
}

/** MUST stay identical to resortSlug() in src/lib/local/resort-core.ts. */
function resortSlug(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')           // punctuation → space
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 120)
}

// [name, name_ar, km_marker, location_note] — listed in road order; the index
// becomes sort_order (×10, leaving room for an admin to slot one in between).
const S = (name, ar, km = null, note = null) => [name, ar, km, note]
const SEED = {
  'North Coast': [
    S('Amoun', 'آمون', 36), S('El Shorouk', 'الشروق', 41), S('Ramses', 'رمسيس', 45), S('Venus 1', 'فينوس 1', 49),
    S('Venus 2', 'فينوس 2', 50), S('Maraqia', 'مراقيا', 51), S('Granada', 'غرناطة', 56), S('Zomoroda', 'زمردة'),
    S('Nice 1', 'نيس 1', 64), S('Nice 2', 'نيس 2', 72), S('Marbella', 'ماربيلا'), S('Diamora', 'ديامورا', 75),
    S('Marseilia Beach 1', 'مارسيليا بيتش 1', 75), S('Mina 3, 4 & 5', 'مينا 3 و 4 و 5'), S('Aida', 'عايدة', 77),
    S('Rosana', 'روزانا', 80), S('Lotus', 'اللوتس'), S('Marina', 'مارينا', 90, 'km 90–120'),
    S('Marina El Alamein', 'مارينا العلمين', null, 'Gates 1–7'), S('Porto Marina', 'بورتو مارينا', 97, 'Gate 3'),
    S('Golf Porto Marina', 'جولف بورتو مارينا'), S('New Alamein Towers', 'أبراج العلمين الجديدة'),
    S('Lazurde Bay', 'لازوردي باي', 120), S('Marseilia Beach 4', 'مارسيليا بيتش 4', 124),
    S('Zahra (Memaar Al Morshedy)', 'زهرة (معمار المرشدي)', 124), S('Hacienda Bay', 'هاسيندا باي', 124),
    S('Marassi', 'مراسي'), S('Stella Heights', 'ستيلا هايتس', 134), S('Seashell', 'سي شيل', 134),
    S('Bianchi', 'بيانكي', 134), S('Amwaj', 'أمواج', 136), S('Hacienda White', 'هاسيندا وايت', 140),
    S('Telal Alamein', 'تلال العلمين', 141), S('Lasirena', 'لاسيرينا', 165), S('D-Bay', 'دي باي', 165, 'Tatweer Misr'),
    S('La Vista Bay / Bay East', 'لافيستا باي / باي إيست'), S('Jefaira', 'جيفيرا', 191), S('The Med', 'ذا ميد'),
    S('Swan Lake', 'سوان ليك'), S('Mountain View Ras El Hekma', 'ماونتن فيو رأس الحكمة'),
    S('Hacienda West', 'هاسيندا ويست', 200), S('Caesar (Sodic)', 'سيزر سوديك'), S('Royal Beach', 'رويال بيتش'),
    S('Fouka Bay', 'فوكا باي', 211), S('Jumeirah Bay (Fouka)', 'جميرا باي (خليج فوكة)', 214),
  ],
  'Ain Sokhna': [
    S('El Ein Bay', 'عين باي', 30, 'Closest to the gates'), S('Blumar', 'بلومار السخنة', 32), S('Azha', 'أزها', 34),
    S('Marina Wadi Degla', 'مارينا وادي دجلة', 36), S('Little Venice', 'ليتل فينيس', 36), S('Tulip', 'توليب السخنة', 38),
    S('Stella Di Mare', 'ستيلا دي ماري'), S('Palm Beach', 'بالم بيتش', 50), S('Sokhna Hills', 'السخنة هيلز', 52),
    S('Blue Bay Asia', 'بلو باي آسيا', 55), S('Laguna Bay', 'لاجونا باي', 60), S('Lasirena', 'لاسيرينا السخنة', 65),
    S('Lasirena Mini Egypt', 'لاسيرينا ميني إيجيبت', 68), S('Cancun Resort', 'كانكون', 70),
    S('Orlando 1 & 2', 'أورلاندو 1 و 2', 72), S('La Vista 1–7', 'لافيستا 1–7', 70, 'Spread km 70–90'),
    S('Il Monte Galala', 'المونت جلالة', null, 'Start of Galala road'), S('The Groove', 'ذا جروف', null, '11 km before Porto'),
    S('Jebal Resort', 'جبال ريزورت', null, '3 km before Porto'), S('Baymount', 'باي ماونت', null, 'Galala heights'),
    S('Porto Sokhna', 'بورتو السخنة'), S('Bella Vento', 'بيلا فينتو الجلالة'), S('Majesty Bay', 'ماجيستي باي الجلالة'),
    S('Sky City', 'سكاي سيتي الجلالة'), S('Carnelia', 'كارنيليا السخنة'), S('Majada', 'ماجادا'),
    S('Telal Sokhna & Telal Shores', 'تلال السخنة', null, '5 min after Porto'), S('Palm Hills Sokhna', 'بالم هيلز السخنة'),
    S('La Vista Ray', 'لافيستا راي'), S('La Vista Gardens', 'لافيستا جاردنز'), S('La Vista Topaz', 'لافيستا توباز'),
    S('Blue Blue', 'بلو بلو السخنة'), S('Bellagio', 'بلاجيو'),
  ],
  'Ras Sudr': [
    S('La Vento Oyoun Mousa', 'لافينتو عيون موسى'), S('Remas', 'ريماس'), S('Coral Beach', 'كورال بيتش'),
    S('Mousa Coast', 'موسى كوست'), S('Paradise', 'بارادايس رأس سدر'), S('Matarma Bay', 'مطارمة باي'),
    S('Matarma Residence', 'مطارمة ريزيدينس'), S('La Hacienda', 'لا هاسيندا'), S('Bay Side', 'باي سايد'),
    S('Blue Lagoon', 'بلو لاجون'), S('Nuzha Beach', 'النزهة بيتش'), S('La Playa', 'لابلايا'), S('Lasirena', 'لاسيرينا'),
    S('Ladera Red Sea', 'لاديرا ريد سي'), S('Sian', 'سيان'), S('Valley Red Sea', 'فالي ريد سي'), S('Tavera', 'تافيرا'),
    S('Fantasia', 'فانتازيا'), S('White Bay', 'وايت باي'),
  ],
  'Cairo': [
    S('Zamalek', 'الزمالك'), S('Garden City', 'جاردن سيتي'), S('Downtown', 'وسط البلد'), S('Maadi', 'المعادي'),
    S('Heliopolis', 'مصر الجديدة'), S('Nasr City', 'مدينة نصر'), S('Mokattam', 'المقطم'), S('Manial', 'المنيل'),
  ],
  'New Cairo': [
    S('Fifth Settlement', 'التجمع الخامس'), S('First Settlement', 'التجمع الأول'), S('Third Settlement', 'التجمع الثالث'),
    S('Rehab', 'الرحاب'), S('Madinaty', 'مدينتي'), S('El Shorouk', 'الشروق'), S('Mostakbal City', 'مدينة المستقبل'),
    S('New Capital', 'العاصمة الإدارية'),
  ],
  'Giza': [
    S('Mohandessin', 'المهندسين'), S('Dokki', 'الدقي'), S('Agouza', 'العجوزة'), S('Haram & Pyramids', 'الهرم'),
    S('Faisal', 'فيصل'), S('Hadayek El Ahram', 'حدائق الأهرام'), S('Sheikh Zayed', 'الشيخ زايد'),
    S('6th of October', 'السادس من أكتوبر'),
  ],
  // Alexandria, Marsa Matrouh, Hurghada, El Gouna, Sharm El Sheikh, Dahab: no
  // sub-areas — the rail hides the chip row for them.
}

const DDL = `
ALTER TABLE resorts ADD COLUMN IF NOT EXISTS name_ar       text;
ALTER TABLE resorts ADD COLUMN IF NOT EXISTS km_marker     numeric(5,1);
ALTER TABLE resorts ADD COLUMN IF NOT EXISTS location_note text;
-- Seeded rows get index×10; anything an admin adds lands after them (1000).
ALTER TABLE resorts ADD COLUMN IF NOT EXISTS sort_order    smallint NOT NULL DEFAULT 1000;
`

const url = databaseUrl()
const isLocal = url.includes('127.0.0.1') || url.includes('localhost')
const pool = new pg.Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } })
;(async () => {
  const { rows: t } = await pool.query(`SELECT to_regclass('public.resorts') AS t`)
  if (!t[0].t) throw new Error('resorts table missing — run migrate-resorts.mjs first')
  await pool.query(DDL)

  // Existing slug → region, so a name that collides with ANOTHER region's row
  // (seeded earlier in this loop, or already in the DB) gets a suffixed slug.
  const { rows: existing } = await pool.query(`SELECT slug, region FROM resorts`)
  const owner = new Map(existing.map((r) => [r.slug, r.region]))
  const seeded = []
  let inserted = 0
  let updated = 0

  for (const [region, subs] of Object.entries(SEED)) {
    for (const [i, [name, ar, km, note]] of subs.entries()) {
      let slug = resortSlug(name)
      if (owner.has(slug) && owner.get(slug) !== region) slug = `${slug}-${resortSlug(region)}`
      owner.set(slug, region)
      seeded.push(slug)
      const r = await pool.query(
        `INSERT INTO resorts (name, slug, region, name_ar, km_marker, location_note, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'migration')
         ON CONFLICT (slug) DO UPDATE
            SET name_ar       = COALESCE(resorts.name_ar, EXCLUDED.name_ar),
                km_marker     = COALESCE(resorts.km_marker, EXCLUDED.km_marker),
                location_note = COALESCE(resorts.location_note, EXCLUDED.location_note),
                sort_order    = CASE WHEN resorts.sort_order = 1000 THEN EXCLUDED.sort_order ELSE resorts.sort_order END,
                updated_at    = now()
         RETURNING (xmax = 0) AS inserted`,
        [name, slug, region, ar, km, note, i * 10]
      )
      if (r.rows[0].inserted) inserted++
      else updated++
    }
  }

  // Old starter-seed extras (Sidi Abdel Rahman, Amouage, …): keep while a
  // listing uses them, hide from the host dropdown otherwise. Admin-created
  // resorts (created_by <> 'migration') are never touched.
  const off = await pool.query(
    `UPDATE resorts r SET is_active = false, updated_at = now()
      WHERE r.created_by = 'migration' AND r.is_active
        AND NOT (r.slug = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.resort_id = r.id)
      RETURNING r.name`,
    [seeded]
  )

  const { rows: dist } = await pool.query(
    `SELECT region, count(*) FILTER (WHERE is_active)::int AS active, count(*)::int AS total
       FROM resorts GROUP BY region ORDER BY region`
  )
  console.log(`✅ destinations ready — ${inserted} sub-area(s) added, ${updated} existing updated`)
  if (off.rowCount) console.log(`   deactivated (unused, not in the list): ${off.rows.map((r) => r.name).join(', ')}`)
  for (const r of dist) console.log(`   ${String(r.active).padStart(4)} active / ${r.total}  ${r.region}`)
  await pool.end()
})().catch(async (e) => { console.error('MIGRATION FAILED:', e); try { await pool.end() } catch {}; process.exit(1) })
