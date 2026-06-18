import { containsPhoneNumber, combinesIntoPhoneNumber } from '../src/lib/local/contentguard.ts'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('✓', label) } else { fail++; console.log('✗ FAIL', label) } }

// ---- single-message blocks (should all be detected) ----
const BLOCK = [
  '01012345678',
  '010 123 45 67',
  '010-123-4567',
  'whatsapp me 01012345678',
  'my number is zero one zero one two three four five six seven eight',
  '٠١٠١٢٣٤٥٦٧٨',
  '+20 100 123 4567',
]
for (const t of BLOCK) ok(containsPhoneNumber(t), `block single: "${t}"`)

// ---- benign single messages (must NOT be flagged) ----
const ALLOW = [
  'see you at 2pm',
  '2 guests, room 401',
  'it costs 3500 EGP for 2 nights',
  "I'll arrive at 5, checkout at 11",
  'the villa sleeps 6 and has 2 pools',
  'is breakfast included?',
  'great, booking ref 4521 confirmed',
]
for (const t of ALLOW) ok(!containsPhoneNumber(t), `allow single: "${t}"`)

// ---- cross-message: bare fragments (Path 1) → block ----
ok(combinesIntoPhoneNumber(['010', '1234567'], '8'), 'block split bare: 010 / 1234567 / 8')
ok(combinesIntoPhoneNumber(['0 1 0', '1 2 3'], '4 5 6 7 8'), 'block split spaced fragments')

// ---- cross-message: digits inside sentences + contact intent (Path 2) → block ----
ok(combinesIntoPhoneNumber(['you can reach me at 0100'], '1234567 anytime'),
   'block split sentence: "reach me 0100" + "1234567 anytime"')
ok(combinesIntoPhoneNumber(['my number starts 010'], 'then 1234 5678 ok thanks'),
   'block split sentence: "my number 010" + "1234 5678"')
ok(combinesIntoPhoneNumber(['hi there', 'call me when you land 0111'], 'rest is 2223334'),
   'block split sentence: "call me 0111" + "2223334"')

// ---- cross-message: benign (must NOT be flagged) ----
ok(!combinesIntoPhoneNumber(['the villa sleeps 6'], 'and has 2 bathrooms'),
   'allow split benign: rooms/baths (no hint, short)')
ok(!combinesIntoPhoneNumber(['it costs 3500 for the week'], 'so 500 per night roughly'),
   'allow split benign: pricing chatter (no contact hint)')
ok(!combinesIntoPhoneNumber(['arriving on the 12th'], 'leaving on the 15th, 3 of us'),
   'allow split benign: dates + guest count')
ok(!combinesIntoPhoneNumber(['call me later about breakfast'], 'we are 2 adults 1 child'),
   'allow split benign: contact word but only 4 digits total')

console.log(`\n===== guard: ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
