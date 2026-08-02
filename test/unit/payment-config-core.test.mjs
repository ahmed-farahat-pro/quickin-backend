// Unit tests for src/lib/local/payment-config-core.ts — the validators behind the
// admin-configurable Instapay destination (number, QR image, deep link).
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. payment-config-core.ts has no relative imports, which is
// what makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  INSTAPAY_KEYS,
  MAX_HANDLE_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_LINK_CHARS,
  MAX_QR_CHARS,
  isPaymentConfigError,
  isPaymentConfigured,
  normalizeHandle,
  normalizeInstapayLink,
  normalizeInstructions,
  normalizeQrImage,
  qrPayload,
  rowsToPaymentConfig,
} from '../../src/lib/local/payment-config-core.ts'

/** A minimal but structurally valid PNG data URL. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

describe('INSTAPAY_KEYS', () => {
  test('are the app_settings rows the destination is stored in', () => {
    assert.deepEqual(Object.values(INSTAPAY_KEYS), [
      'instapay_handle',
      'instapay_instructions',
      'instapay_link',
      'instapay_qr_image',
    ])
  })
})

describe('normalizeHandle / normalizeInstructions', () => {
  test('trim and cap, and treat missing input as empty', () => {
    assert.equal(normalizeHandle('  someone@instapay  '), 'someone@instapay')
    assert.equal(normalizeHandle(undefined), '')
    assert.equal(normalizeHandle(null), '')
    assert.equal(normalizeHandle('x'.repeat(500)).length, MAX_HANDLE_CHARS)
    assert.equal(normalizeInstructions('  pay the exact total  '), 'pay the exact total')
    assert.equal(normalizeInstructions('y'.repeat(5000)).length, MAX_INSTRUCTIONS_CHARS)
  })
})

describe('normalizeInstapayLink', () => {
  test('accepts http(s) links and trims them', () => {
    assert.equal(
      normalizeInstapayLink('  https://ipn.eg/S/someone/instapay/ABC123  '),
      'https://ipn.eg/S/someone/instapay/ABC123'
    )
    assert.equal(normalizeInstapayLink('http://ipn.eg/x'), 'http://ipn.eg/x')
  })

  test('empty input clears the link rather than erroring', () => {
    assert.equal(normalizeInstapayLink(''), '')
    assert.equal(normalizeInstapayLink('   '), '')
    assert.equal(normalizeInstapayLink(undefined), '')
  })

  test('rejects non-http schemes — the guest UIs render this inside an anchor', () => {
    // eslint-disable-next-line no-script-url
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'ipn.eg/S/x', 'ftp://ipn.eg']) {
      assert.throws(() => normalizeInstapayLink(bad), isPaymentConfigError, `should reject ${bad}`)
    }
  })

  test('rejects a link with whitespace inside it', () => {
    assert.throws(() => normalizeInstapayLink('https://ipn.eg/a b'), isPaymentConfigError)
  })

  test('rejects an over-long link', () => {
    assert.throws(() => normalizeInstapayLink('https://ipn.eg/' + 'a'.repeat(MAX_LINK_CHARS)), isPaymentConfigError)
  })
})

describe('normalizeQrImage', () => {
  test('accepts base64 data URLs for raster image types', () => {
    assert.equal(normalizeQrImage(PNG), PNG)
    assert.equal(normalizeQrImage('data:image/jpeg;base64,/9j/4AAQ'), 'data:image/jpeg;base64,/9j/4AAQ')
    assert.equal(normalizeQrImage('data:image/webp;base64,UklGRg=='), 'data:image/webp;base64,UklGRg==')
  })

  test('accepts an https URL, and empty clears the upload', () => {
    assert.equal(normalizeQrImage('https://cdn.example.com/qr.png'), 'https://cdn.example.com/qr.png')
    assert.equal(normalizeQrImage(''), '')
    assert.equal(normalizeQrImage('   '), '')
  })

  test('rejects SVG — the one image type that can carry markup', () => {
    assert.throws(() => normalizeQrImage('data:image/svg+xml;base64,PHN2Zz4='), isPaymentConfigError)
  })

  test('rejects non-images and plaintext http', () => {
    for (const bad of ['data:text/html;base64,PGI+', 'http://example.com/qr.png', 'not-an-image']) {
      assert.throws(() => normalizeQrImage(bad), isPaymentConfigError, `should reject ${bad}`)
    }
  })

  test('rejects an image past the size cap', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_QR_CHARS)
    assert.throws(() => normalizeQrImage(huge), isPaymentConfigError)
  })
})

describe('qrPayload', () => {
  test('prefers the link, because scanning it opens Instapay directly', () => {
    assert.equal(qrPayload('someone@instapay', 'https://ipn.eg/x'), 'https://ipn.eg/x')
  })

  test('falls back to the handle, and is empty when nothing is set', () => {
    assert.equal(qrPayload('someone@instapay', ''), 'someone@instapay')
    assert.equal(qrPayload('someone@instapay', '   '), 'someone@instapay')
    assert.equal(qrPayload('', ''), '')
  })
})

describe('rowsToPaymentConfig', () => {
  test('maps app_settings rows onto the guest-facing shape', () => {
    const cfg = rowsToPaymentConfig([
      { key: 'instapay_handle', value: ' someone@instapay ' },
      { key: 'instapay_instructions', value: 'Send the exact total.' },
      { key: 'instapay_link', value: ' https://ipn.eg/S/someone ' },
      { key: 'instapay_qr_image', value: PNG },
    ])
    assert.deepEqual(cfg, {
      instapay_handle: 'someone@instapay',
      instructions: 'Send the exact total.',
      instapay_link: 'https://ipn.eg/S/someone',
      instapay_qr_image: PNG,
      qr_payload: 'https://ipn.eg/S/someone',
    })
  })

  test('missing rows read as empty, so adding a key needs no migration', () => {
    const cfg = rowsToPaymentConfig([{ key: 'instapay_handle', value: 'someone@instapay' }])
    assert.equal(cfg.instapay_link, '')
    assert.equal(cfg.instapay_qr_image, '')
    assert.equal(cfg.instructions, '')
    assert.equal(cfg.qr_payload, 'someone@instapay', 'clients can still draw a QR')
  })

  test('a NULL value is treated as empty, not "null"', () => {
    const cfg = rowsToPaymentConfig([
      { key: 'instapay_handle', value: null },
      { key: 'instapay_link', value: null },
    ])
    assert.equal(cfg.instapay_handle, '')
    assert.equal(cfg.qr_payload, '')
  })

  test('an empty table yields a fully blank, unconfigured config', () => {
    const cfg = rowsToPaymentConfig([])
    assert.equal(isPaymentConfigured(cfg), false)
  })
})

describe('isPaymentConfigured', () => {
  test('a handle alone or a link alone is enough to take payment', () => {
    assert.equal(isPaymentConfigured(rowsToPaymentConfig([{ key: 'instapay_handle', value: 'a@instapay' }])), true)
    assert.equal(isPaymentConfigured(rowsToPaymentConfig([{ key: 'instapay_link', value: 'https://ipn.eg/x' }])), true)
  })

  test('a QR image alone is not — there would be nothing to verify against', () => {
    assert.equal(isPaymentConfigured(rowsToPaymentConfig([{ key: 'instapay_qr_image', value: PNG }])), false)
  })
})

describe('isPaymentConfigError', () => {
  test('is true only for this module’s validation failures', () => {
    assert.equal(isPaymentConfigError(new Error('boom')), false)
    assert.equal(isPaymentConfigError(null), false)
    try {
      normalizeInstapayLink('nope')
      assert.fail('should have thrown')
    } catch (e) {
      assert.equal(isPaymentConfigError(e), true)
      assert.match(e.message, /http/, 'the message is shown to the admin, so it must be actionable')
    }
  })
})
