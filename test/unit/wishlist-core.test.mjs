// Unit tests for src/lib/local/wishlist-core.ts — what the wishlist accepts now that
// Services were removed (2026-10-20): listings only, 'service' refused with 410,
// and the old response keys kept (empty) for app builds already on phones.
//
// Offline: no database, no network. Run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SERVICES_GONE_ERROR,
  emptyServicesPart,
  parseWishItemType,
} from '../../src/lib/local/wishlist-core.ts'

describe('parseWishItemType', () => {
  test("refuses 'service' with 410 and the shared message", () => {
    assert.deepEqual(parseWishItemType('service'), { ok: false, status: 410, error: SERVICES_GONE_ERROR })
    assert.equal(SERVICES_GONE_ERROR, 'Services have been removed')
  })
  test("'listing' is a listing", () => {
    assert.deepEqual(parseWishItemType('listing'), { ok: true, type: 'listing' })
  })
  test('a missing or unknown type still means a listing, as before the removal', () => {
    for (const v of [undefined, null, '', 'stay', 42, {}]) {
      assert.deepEqual(parseWishItemType(v), { ok: true, type: 'listing' }, String(v))
    }
  })
})

describe('emptyServicesPart', () => {
  test('keeps both old keys, always empty', () => {
    assert.deepEqual(emptyServicesPart(), { services: [], serviceIds: [] })
  })
  test('returns fresh arrays each call, so a caller cannot poison the next response', () => {
    const a = emptyServicesPart()
    a.services.push('x')
    assert.deepEqual(emptyServicesPart().services, [])
  })
})
