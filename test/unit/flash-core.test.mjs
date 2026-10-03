// Unit tests for src/lib/local/flash-core.ts — Flash (useflash.app) webhook
// signing, status vocabulary, order body and checkout-reuse rules.
// Offline: no database, no network. Run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  FLASH_DEFAULT_BASE_URL,
  FLASH_MIN_AMOUNT_CENTS,
  FLASH_ORDER_VALIDITY_SECONDS,
  basicAuthHeader,
  buildAggregatorOrderId,
  buildOrderBody,
  canReuseOrder,
  canTransition,
  computeSignature,
  errorCodeOf,
  errorMessageOf,
  flashSettingsFrom,
  flattenForSignature,
  isOpenFlashStatus,
  normalizeFlashStatus,
  paidEnough,
  parseOrderResponse,
  parseWebhook,
  signaturePayload,
  toAmountCents,
  verifySignature,
} from '../../src/lib/local/flash-core.ts'

// The webhook body from Flash's "Dynamic QR API" spec, and the exact string the
// spec says it flattens to. If this ever stops matching, signatures break.
const SPEC_BODY = {
  transactionId: 'txn_123456789',
  channelId: 'channel_001',
  integrationId: 'order_integration_123',
  merchantOrderId: 'order_merchant_456',
  aggregatorOrderId: 'order_merchant_456',
  order: {
    id: 'order_123456',
    description: 'Premium subscription for mobile app',
    customer: { name: 'Ahmed Hassan', email: 'ahmed.hassan@example.com', phone: '+201234567890' },
    amountCents: 299900,
    currency: 'EGP',
    paymentLink: 'https://flash.com/pay/order_123456',
    createdAt: '1755460779',
    additionalInfo: {
      customerNotes: 'Please deliver to main entrance',
      merchantReference: 'REF-2024-001',
      promotionCode: 'WINTER2024',
    },
  },
  status: 'SUCCEEDED',
  paidAmountCents: 299900,
  tipsAmountCents: 5000,
  feesAmountCents: 15000,
  updatedAt: '1755460779',
}
const SPEC_STRING =
  'aggregatorOrderId=order_merchant_456,channelId=channel_001,feesAmountCents=15000,' +
  'integrationId=order_integration_123,merchantOrderId=order_merchant_456,' +
  'order.additionalInfo.customerNotes=Please deliver to main entrance,' +
  'order.additionalInfo.merchantReference=REF-2024-001,order.additionalInfo.promotionCode=WINTER2024,' +
  'order.amountCents=299900,order.createdAt=1755460779,order.currency=EGP,' +
  'order.customer.email=ahmed.hassan@example.com,order.customer.name=Ahmed Hassan,' +
  'order.customer.phone=+201234567890,order.description=Premium subscription for mobile app,' +
  'order.id=order_123456,order.paymentLink=https://flash.com/pay/order_123456,' +
  'paidAmountCents=299900,status=SUCCEEDED,tipsAmountCents=5000,transactionId=txn_123456789,' +
  'updatedAt=1755460779'
const SECRET = 'test-secret-not-real'

describe('signature', () => {
  test('flattens the spec example to the spec string, byte for byte', () => {
    assert.equal(signaturePayload(SPEC_BODY), SPEC_STRING)
  })

  test('computeSignature is hex HMAC-SHA256 of that string', () => {
    const want = createHmac('sha256', SECRET).update(SPEC_STRING, 'utf8').digest('hex')
    assert.equal(computeSignature(SPEC_BODY, SECRET), want)
  })

  test('verifySignature accepts the right signature in any case, with or without sha256=', () => {
    const sig = computeSignature(SPEC_BODY, SECRET)
    assert.equal(verifySignature(SPEC_BODY, sig, SECRET), true)
    assert.equal(verifySignature(SPEC_BODY, sig.toUpperCase(), SECRET), true)
    assert.equal(verifySignature(SPEC_BODY, `sha256=${sig}`, SECRET), true)
  })

  test('verifySignature rejects a tampered body, a wrong secret, junk and an empty secret', () => {
    const sig = computeSignature(SPEC_BODY, SECRET)
    assert.equal(verifySignature({ ...SPEC_BODY, status: 'FAILED' }, sig, SECRET), false)
    assert.equal(verifySignature({ ...SPEC_BODY, paidAmountCents: 1 }, sig, SECRET), false)
    assert.equal(verifySignature(SPEC_BODY, sig, 'other'), false)
    assert.equal(verifySignature(SPEC_BODY, 'nope', SECRET), false)
    assert.equal(verifySignature(SPEC_BODY, null, SECRET), false)
    assert.equal(verifySignature(SPEC_BODY, sig, ''), false)
  })

  test('empty values are omitted (spec step 2), so they cannot change the signature', () => {
    const withEmpties = { ...SPEC_BODY, note: '', extra: null, nothing: undefined, order: { ...SPEC_BODY.order, tag: '' } }
    assert.equal(signaturePayload(withEmpties), SPEC_STRING)
  })

  test('a field Flash adds later is signed too — nothing is named', () => {
    assert.match(signaturePayload({ ...SPEC_BODY, newField: 'x' }), /newField=x/)
  })

  test('zero and false are values, not empties', () => {
    assert.deepEqual(flattenForSignature({ a: 0, b: false }), { a: '0', b: 'false' })
  })

  test('arrays flatten by index', () => {
    assert.deepEqual(flattenForSignature({ items: [{ k: 'v' }, 'x'] }), { 'items.0.k': 'v', 'items.1': 'x' })
  })
})

describe('status', () => {
  test('normalizes Flash spellings', () => {
    assert.equal(normalizeFlashStatus('SUCCEEDED'), 'succeeded')
    assert.equal(normalizeFlashStatus(' succeeded '), 'succeeded')
    assert.equal(normalizeFlashStatus('cancelled'), 'canceled')
    assert.equal(normalizeFlashStatus('CANCELED'), 'canceled')
    assert.equal(normalizeFlashStatus('refunded'), 'refunded')
  })

  test('an unknown word is pending — never paid, never closed', () => {
    assert.equal(normalizeFlashStatus('weird'), 'pending')
    assert.equal(normalizeFlashStatus(undefined), 'pending')
  })

  test('open statuses', () => {
    assert.equal(isOpenFlashStatus('pending'), true)
    assert.equal(isOpenFlashStatus('processing'), true)
    for (const s of ['succeeded', 'failed', 'canceled', 'refunded', 'expired']) assert.equal(isOpenFlashStatus(s), false)
  })

  test('money only moves forward', () => {
    assert.equal(canTransition('pending', 'succeeded'), true)
    assert.equal(canTransition('processing', 'succeeded'), true)
    assert.equal(canTransition('pending', 'processing'), true)
    assert.equal(canTransition('succeeded', 'refunded'), true)
    // A late pending/failed can't un-pay a booking.
    assert.equal(canTransition('succeeded', 'pending'), false)
    assert.equal(canTransition('succeeded', 'failed'), false)
    assert.equal(canTransition('succeeded', 'canceled'), false)
    assert.equal(canTransition('refunded', 'succeeded'), false)
    assert.equal(canTransition('processing', 'pending'), false)
    assert.equal(canTransition('succeeded', 'succeeded'), false)
  })

  test('money that arrives after we gave up still counts', () => {
    assert.equal(canTransition('expired', 'succeeded'), true)
    assert.equal(canTransition('canceled', 'succeeded'), true)
    assert.equal(canTransition('failed', 'succeeded'), true)
    assert.equal(canTransition('expired', 'pending'), false)
  })
})

describe('money', () => {
  test('toAmountCents rounds and refuses junk', () => {
    assert.equal(toAmountCents(1234.5), 123450)
    assert.equal(toAmountCents(0.1 + 0.2), 30)
    assert.equal(toAmountCents('99.99'), 9999)
    assert.equal(toAmountCents(0), 0)
    assert.equal(toAmountCents(-5), 0)
    assert.equal(toAmountCents('abc'), 0)
  })

  test('minimum is 5 EGP', () => assert.equal(FLASH_MIN_AMOUNT_CENTS, 500))

  test('paidEnough', () => {
    assert.equal(paidEnough(1000, 1000), true)
    assert.equal(paidEnough(1000, 1500), true)
    assert.equal(paidEnough(1000, 999), false)
    assert.equal(paidEnough(1000, undefined), true)
    assert.equal(paidEnough(1000, null), true)
    assert.equal(paidEnough(1000, 'x'), false)
  })
})

describe('settings', () => {
  const full = { FLASH_CLIENT_ID: 'id', FLASH_CLIENT_SECRET: 'sec', FLASH_INTEGRATION_ID: '55911771', FLASH_HMAC_SECRET: 'h' }
  test('all four credentials are required', () => {
    assert.ok(flashSettingsFrom(full))
    for (const k of Object.keys(full)) assert.equal(flashSettingsFrom({ ...full, [k]: '' }), null, k)
    assert.equal(flashSettingsFrom({ ...full, FLASH_INTEGRATION_ID: 'abc' }), null)
    assert.equal(flashSettingsFrom({}), null)
  })
  test('base URL defaults to production and loses its trailing slash', () => {
    assert.equal(flashSettingsFrom(full).baseUrl, FLASH_DEFAULT_BASE_URL)
    assert.equal(flashSettingsFrom({ ...full, FLASH_BASE_URL: 'https://stg-api.useflash.app/' }).baseUrl, 'https://stg-api.useflash.app')
    assert.equal(flashSettingsFrom(full).integrationId, 55911771)
  })
  test('basic auth header', () => {
    assert.equal(basicAuthHeader('a', 'b'), `Basic ${Buffer.from('a:b').toString('base64')}`)
  })
})

describe('orders', () => {
  test('aggregator id is unique per attempt and names the booking', () => {
    const id = '0b5c1f8e-1111-4222-8333-944455556666'
    const a = buildAggregatorOrderId(id, 1_000_000, 'ab12')
    const b = buildAggregatorOrderId(id, 1_000_001, 'ab12')
    assert.notEqual(a, b)
    assert.ok(a.startsWith(`qk-${id}-`))
    assert.equal(buildAggregatorOrderId(id, 5, '<x>'), `qk-${id}-5-x`)
  })

  test('order body: online, web-enabled, EGP, booking metadata', () => {
    const body = buildOrderBody({
      integrationId: 7, aggregatorOrderId: 'qk-1', amountCents: 12345, bookingId: 'b1',
      reservationCode: 'QK-AB12', customerName: ' Sara ', customerPhone: '+2010', description: 'Stay',
    })
    assert.equal(body.integrationId, 7)
    assert.equal(body.amountCents, 12345)
    assert.equal(body.currency, 'EGP')
    assert.equal(body.orderType, 'online')
    assert.equal(body.webEnabled, true)
    assert.equal(body.validity, FLASH_ORDER_VALIDITY_SECONDS)
    assert.deepEqual(body.customer, { name: 'Sara', phone: '+2010' })
    assert.deepEqual(body.additionalInfo, [{ key: 'booking_id', value: 'b1' }, { key: 'reservation_code', value: 'QK-AB12' }])
  })

  test('no customer object without a phone — Flash refuses one', () => {
    const body = buildOrderBody({ integrationId: 7, aggregatorOrderId: 'qk-1', amountCents: 600, bookingId: 'b1' })
    assert.equal('customer' in body, false)
    const named = buildOrderBody({ integrationId: 7, aggregatorOrderId: 'qk-1', amountCents: 600, bookingId: 'b1', customerName: 'Sara', customerPhone: '  ' })
    assert.equal('customer' in named, false)
  })

  const now = Date.parse('2026-10-03T12:00:00Z')
  const open = { status: 'pending', amount_cents: 1000, payment_link: 'https://x', expires_at: '2026-10-03T12:20:00Z' }
  test('reuse an open link for the same amount with time left', () => {
    assert.equal(canReuseOrder(open, 1000, now), true)
  })
  test('never reuse a link for a different amount, a closed order, or one about to expire', () => {
    assert.equal(canReuseOrder(open, 1100, now), false)
    assert.equal(canReuseOrder({ ...open, status: 'canceled' }, 1000, now), false)
    assert.equal(canReuseOrder({ ...open, status: 'succeeded' }, 1000, now), false)
    assert.equal(canReuseOrder({ ...open, expires_at: '2026-10-03T12:04:00Z' }, 1000, now), false)
    assert.equal(canReuseOrder({ ...open, payment_link: null }, 1000, now), false)
    assert.equal(canReuseOrder(null, 1000, now), false)
  })
})

describe('parsing', () => {
  // Shape observed from Flash staging, 2026-10-03.
  const created = {
    order: {
      id: 'c7f91dfa-0b1f-4f87-8f67-2e784809feea', aggregatorOrderId: 'qk-1', merchantOrderId: 'qk-1',
      amountCents: 1000, paymentLink: 'https://testlink.useflash.app/x', status: 'pending',
    },
    paymentLink: 'https://testlink.useflash.app/x',
  }
  test('order response', () => {
    assert.deepEqual(parseOrderResponse(created), {
      id: 'c7f91dfa-0b1f-4f87-8f67-2e784809feea', aggregatorOrderId: 'qk-1', status: 'pending',
      amountCents: 1000, paidAmountCents: null, paymentLink: 'https://testlink.useflash.app/x',
    })
    assert.equal(parseOrderResponse({ error: { code: 'X' } }), null)
    assert.equal(parseOrderResponse(null), null)
  })
  test('webhook', () => {
    const w = parseWebhook(SPEC_BODY)
    assert.equal(w.aggregatorOrderId, 'order_merchant_456')
    assert.equal(w.status, 'succeeded')
    assert.equal(w.paidAmountCents, 299900)
    assert.equal(w.amountCents, 299900)
    assert.equal(parseWebhook({ status: 'SUCCEEDED' }), null)
  })
  test('error code', () => {
    assert.equal(errorCodeOf({ error: { code: 'ORDER_BELOW_MINIMUM', message: 'x' } }), 'ORDER_BELOW_MINIMUM')
    assert.equal(errorCodeOf({}), null)
    assert.equal(errorCodeOf(null), null)
    assert.equal(errorMessageOf({ error: { message: 'invalid: phone (field required)' } }), 'invalid: phone (field required)')
    assert.equal(errorMessageOf({}), null)
  })
})
