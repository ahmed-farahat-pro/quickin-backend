// Regression guard for the Apple Wallet pass — GET /api/wallet/pass/:bookingId.
//
// Offline: no database, no network. Run with `npm test`.
//
// Why a source assertion: the route builds a signed PKPass from env-held
// certificates and imports `@/lib/...` paths a test cannot resolve (see README →
// Testing), and there is no pure-logic seam — the behaviour IS the pass layout.
//
// The rule it guards: the stay pass has NO QR code (removed 2026-11-13 on web,
// iOS, Android and here). The pass shows the reservation code as text on the
// front instead. Deliberately loose about how the field is written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('../../src/app/api/wallet/pass/[bookingId]/route.ts', import.meta.url)),
  'utf8'
)

test('the Wallet pass sets no barcode', () => {
  assert.doesNotMatch(SRC, /setBarcodes\s*\(/)
  assert.doesNotMatch(SRC, /PKBarcodeFormat/)
  assert.doesNotMatch(SRC, /barcodes\s*:/)
})

test('the reservation code is on the front of the pass', () => {
  assert.match(SRC, /headerFields\.push\(\{[^}]*value:\s*reservationCode/s)
})
