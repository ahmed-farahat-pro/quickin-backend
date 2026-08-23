// Unit tests for src/lib/local/payment-config-core.ts — the validators behind the
// admin-configurable payment destinations: Instapay (number, QR image, deep link)
// and bank transfer (bank, account holder, account number, optional IBAN).
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. payment-config-core.ts has no relative imports, which is
// what makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BANK_KEYS,
  INSTAPAY_KEYS,
  MAX_ACCOUNT_NUMBER_CHARS,
  MAX_HANDLE_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_LINK_CHARS,
  MAX_QR_CHARS,
  PAYMENT_METHODS,
  PAYMENT_SETTING_KEYS,
  availableMethods,
  bankConfigGap,
  boolToStored,
  formatIban,
  ibanChecksumValid,
  isBankConfigured,
  isInstapayConfigured,
  isPaymentConfigError,
  isPaymentConfigured,
  isPaymentMethod,
  normalizeAccountName,
  normalizeAccountNumber,
  normalizeBankIban,
  normalizeBankName,
  normalizeHandle,
  normalizeInstapayLink,
  normalizeInstructions,
  normalizePaymentMethod,
  normalizeQrImage,
  qrPayload,
  rowsToPaymentConfig,
  storedToBool,
} from '../../src/lib/local/payment-config-core.ts'

/** A fully filled-in bank destination, as app_settings rows. */
const BANK_ROWS = [
  { key: 'bank_name', value: 'Banque Misr' },
  { key: 'bank_account_name', value: 'QuickIn for Tourism' },
  { key: 'bank_account_number', value: '1234567890123' },
]

/** Published specimen IBANs — valid checksum AND valid country length. */
const VALID_IBANS = {
  EG: 'EG380019000500000000263180002',
  GB: 'GB82WEST12345698765432',
  DE: 'DE89370400440532013000',
  SA: 'SA0380000000608010167519',
}

/** A minimal but structurally valid PNG data URL. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

describe('INSTAPAY_KEYS', () => {
  test('are the app_settings rows the destination is stored in', () => {
    assert.deepEqual(Object.values(INSTAPAY_KEYS), [
      'instapay_enabled',
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
      instapay_enabled: true,
      bank: {
        enabled: true,
        bank_name: '',
        account_name: '',
        account_number: '',
        iban: '',
        iban_formatted: '',
        instructions: '',
        configured: false,
      },
      available_methods: ['instapay'],
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

describe('isInstapayConfigured', () => {
  test('a handle alone or a link alone is enough to take payment', () => {
    assert.equal(isInstapayConfigured(rowsToPaymentConfig([{ key: 'instapay_handle', value: 'a@instapay' }])), true)
    assert.equal(isInstapayConfigured(rowsToPaymentConfig([{ key: 'instapay_link', value: 'https://ipn.eg/x' }])), true)
  })

  test('a QR image alone is not — there would be nothing to verify against', () => {
    assert.equal(isInstapayConfigured(rowsToPaymentConfig([{ key: 'instapay_qr_image', value: PNG }])), false)
  })
})

describe('isPaymentConfigured', () => {
  test('is true when EITHER method can take money', () => {
    assert.equal(isPaymentConfigured(rowsToPaymentConfig([{ key: 'instapay_handle', value: 'a@instapay' }])), true)
    assert.equal(isPaymentConfigured(rowsToPaymentConfig(BANK_ROWS)), true)
  })

  test('is false when neither can', () => {
    assert.equal(isPaymentConfigured(rowsToPaymentConfig([])), false)
    // A bank block missing the beneficiary name is not payable.
    assert.equal(
      isPaymentConfigured(rowsToPaymentConfig(BANK_ROWS.filter((r) => r.key !== 'bank_account_name'))),
      false,
    )
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

// ---- Payment methods --------------------------------------------------------

describe('PAYMENT_METHODS', () => {
  test('is the vocabulary payment_proofs.method is constrained to', () => {
    assert.deepEqual([...PAYMENT_METHODS], ['instapay', 'bank_transfer'])
  })

  test('isPaymentMethod accepts only those two', () => {
    assert.equal(isPaymentMethod('instapay'), true)
    assert.equal(isPaymentMethod('bank_transfer'), true)
    assert.equal(isPaymentMethod('paymob'), false)
    assert.equal(isPaymentMethod(''), false)
    assert.equal(isPaymentMethod(undefined), false)
  })

  test('normalizePaymentMethod falls back to instapay, never to an unknown value', () => {
    assert.equal(normalizePaymentMethod('bank_transfer'), 'bank_transfer')
    assert.equal(normalizePaymentMethod('  BANK_TRANSFER  '), 'bank_transfer')
    // An older client sends no method at all; a broken one sends nonsense. Both
    // land on the original method rather than poisoning the reviewer's queue.
    assert.equal(normalizePaymentMethod(undefined), 'instapay')
    assert.equal(normalizePaymentMethod('vodafone_cash'), 'instapay')
    assert.equal(normalizePaymentMethod({ nope: 1 }), 'instapay')
  })
})

describe('PAYMENT_SETTING_KEYS', () => {
  test('covers every key both destinations are stored in', () => {
    for (const k of [...Object.values(INSTAPAY_KEYS), ...Object.values(BANK_KEYS)]) {
      assert.ok(PAYMENT_SETTING_KEYS.includes(k), `${k} must be read by getPaymentConfig`)
    }
  })

  test('has no duplicates — it is used as a SQL = ANY() list', () => {
    assert.equal(new Set(PAYMENT_SETTING_KEYS).size, PAYMENT_SETTING_KEYS.length)
  })
})

// ---- Toggles ----------------------------------------------------------------

describe('storedToBool / boolToStored', () => {
  test('round-trips', () => {
    assert.equal(storedToBool(boolToStored(true)), true)
    assert.equal(storedToBool(boolToStored(false)), false)
  })

  test('an unset row means ON, so an existing database never goes dark on deploy', () => {
    assert.equal(storedToBool(undefined), true)
    assert.equal(storedToBool(null), true)
    assert.equal(storedToBool(''), true)
    assert.equal(storedToBool('   '), true)
  })

  test('accepts the human spellings of off as well as 0', () => {
    for (const off of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) {
      assert.equal(storedToBool(off), false, `${off} should read as off`)
    }
    for (const on of ['1', 'true', 'yes', 'on']) {
      assert.equal(storedToBool(on), true, `${on} should read as on`)
    }
  })
})

// ---- Bank destination -------------------------------------------------------

describe('BANK_KEYS', () => {
  test('are the app_settings rows the bank destination is stored in', () => {
    assert.deepEqual(Object.values(BANK_KEYS), [
      'bank_transfer_enabled',
      'bank_name',
      'bank_account_name',
      'bank_account_number',
      'bank_iban',
      'bank_instructions',
    ])
  })
})

describe('normalizeBankName / normalizeAccountName', () => {
  test('trim and collapse inner whitespace', () => {
    assert.equal(normalizeBankName('  Banque   Misr  '), 'Banque Misr')
    assert.equal(normalizeAccountName('QuickIn\n for  Tourism'), 'QuickIn for Tourism')
  })

  test('empty stays empty (clearing the field)', () => {
    assert.equal(normalizeBankName(''), '')
    assert.equal(normalizeAccountName(undefined), '')
  })

  test('are capped rather than rejected — a long legal name is still a name', () => {
    assert.equal(normalizeBankName('b'.repeat(400)).length, 120)
    assert.equal(normalizeAccountName('n'.repeat(400)).length, 120)
  })
})

describe('normalizeAccountNumber', () => {
  test('keeps the number WHOLE — it exists to be typed into a banking app', () => {
    assert.equal(normalizeAccountNumber(' 1234567890123 '), '1234567890123')
  })

  test('allows the separators banks actually print', () => {
    assert.equal(normalizeAccountNumber('1234-5678-9012'), '1234-5678-9012')
    assert.equal(normalizeAccountNumber('100 200 300'), '100 200 300')
    assert.equal(normalizeAccountNumber('123/456/789'), '123/456/789')
    assert.equal(normalizeAccountNumber('eg1234567'), 'EG1234567')
  })

  test('empty stays empty', () => {
    assert.equal(normalizeAccountNumber(''), '')
  })

  test('rejects a value with no digits — that is a name, not an account', () => {
    assert.throws(() => normalizeAccountNumber('MY ACCOUNT'), (e) => isPaymentConfigError(e))
  })

  test('rejects punctuation that would break a copy-paste into a bank form', () => {
    for (const bad of ['1234;DROP', '12<34>', '123 456!', '#12345']) {
      assert.throws(() => normalizeAccountNumber(bad), (e) => isPaymentConfigError(e), `${bad} should be refused`)
    }
  })

  test('rejects one longer than any real account number', () => {
    assert.throws(
      () => normalizeAccountNumber('1'.repeat(MAX_ACCOUNT_NUMBER_CHARS + 1)),
      (e) => isPaymentConfigError(e),
    )
  })
})

describe('ibanChecksumValid', () => {
  test('accepts the published specimens', () => {
    for (const iban of Object.values(VALID_IBANS)) {
      assert.equal(ibanChecksumValid(iban), true, iban)
    }
  })

  test('rejects a transposition that keeps the length', () => {
    // Swap two adjacent digits in the body — same length, broken mod-97.
    const broken = VALID_IBANS.EG.replace('2631', '2613')
    assert.equal(ibanChecksumValid(broken), false)
  })
})

describe('normalizeBankIban', () => {
  test('is OPTIONAL — empty clears it rather than failing', () => {
    assert.equal(normalizeBankIban(''), '')
    assert.equal(normalizeBankIban(undefined), '')
    assert.equal(normalizeBankIban('   '), '')
  })

  test('accepts a valid IBAN however the admin spaced it', () => {
    assert.equal(normalizeBankIban(' eg38 0019 0005 0000 0000 2631 8000 2 '), VALID_IBANS.EG)
    assert.equal(normalizeBankIban('GB82-WEST-1234-5698-7654-32'), VALID_IBANS.GB)
  })

  test('enforces the country length AND the checksum — one alone is not enough', () => {
    // Right checksum shape, wrong length for EG.
    assert.throws(() => normalizeBankIban('EG3800190005000000002631800'), (e) => isPaymentConfigError(e))
    // Right length for EG, broken checksum.
    assert.throws(
      () => normalizeBankIban(VALID_IBANS.EG.replace('2631', '2613')),
      (e) => isPaymentConfigError(e),
    )
  })

  test('rejects something that is plainly not an IBAN', () => {
    assert.throws(() => normalizeBankIban('1234567890123456'), (e) => isPaymentConfigError(e))
    assert.throws(() => normalizeBankIban('EG12'), (e) => isPaymentConfigError(e))
  })
})

describe('formatIban', () => {
  test('groups in fours the way a bank prints one', () => {
    assert.equal(formatIban(VALID_IBANS.DE), 'DE89 3704 0044 0532 0130 00')
  })

  test('empty in, empty out', () => {
    assert.equal(formatIban(''), '')
  })
})

describe('isBankConfigured', () => {
  const base = { bank_name: 'Banque Misr', account_name: 'QuickIn', account_number: '123456', iban: '' }

  test('needs a bank, a beneficiary and a number', () => {
    assert.equal(isBankConfigured(base), true)
  })

  test('an IBAN substitutes for the account number', () => {
    assert.equal(isBankConfigured({ ...base, account_number: '', iban: VALID_IBANS.EG }), true)
  })

  test('is false without the beneficiary name — the transfer would be rejected', () => {
    assert.equal(isBankConfigured({ ...base, account_name: '' }), false)
  })

  test('is false without a bank, or without any number at all', () => {
    assert.equal(isBankConfigured({ ...base, bank_name: '' }), false)
    assert.equal(isBankConfigured({ ...base, account_number: '', iban: '' }), false)
  })
})

describe('bankConfigGap', () => {
  test('says nothing about an untouched destination', () => {
    assert.equal(bankConfigGap({ bank_name: '', account_name: '', account_number: '', iban: '' }), '')
  })

  test('says nothing once it is complete', () => {
    assert.equal(
      bankConfigGap({ bank_name: 'Banque Misr', account_name: 'QuickIn', account_number: '1', iban: '' }),
      '',
    )
  })

  test('names exactly what is missing, so the admin can act on it', () => {
    const gap = bankConfigGap({ bank_name: 'Banque Misr', account_name: '', account_number: '123', iban: '' })
    assert.match(gap, /account holder name/)
    assert.doesNotMatch(gap, /bank name/)
  })
})

// ---- Assembly across both methods -------------------------------------------

describe('rowsToPaymentConfig — bank half', () => {
  test('derives the formatted IBAN and the configured flag', () => {
    const cfg = rowsToPaymentConfig([...BANK_ROWS, { key: 'bank_iban', value: VALID_IBANS.EG }])
    assert.equal(cfg.bank.bank_name, 'Banque Misr')
    assert.equal(cfg.bank.account_number, '1234567890123')
    assert.equal(cfg.bank.iban_formatted, formatIban(VALID_IBANS.EG))
    assert.equal(cfg.bank.configured, true)
    assert.equal(cfg.bank.enabled, true, 'an unset toggle is on')
  })

  test('an empty table yields a blank, unconfigured bank block', () => {
    const cfg = rowsToPaymentConfig([])
    assert.equal(cfg.bank.configured, false)
    assert.equal(cfg.bank.bank_name, '')
    assert.equal(cfg.bank.iban_formatted, '')
  })
})

describe('availableMethods', () => {
  test('offers only what is both enabled and configured', () => {
    const cfg = rowsToPaymentConfig([{ key: 'instapay_handle', value: 'a@instapay' }, ...BANK_ROWS])
    assert.deepEqual(availableMethods(cfg), ['instapay', 'bank_transfer'])
    assert.deepEqual(cfg.available_methods, ['instapay', 'bank_transfer'])
  })

  test('a switched-off method disappears without its details being discarded', () => {
    const cfg = rowsToPaymentConfig([
      { key: 'instapay_handle', value: 'a@instapay' },
      { key: 'instapay_enabled', value: '0' },
      ...BANK_ROWS,
    ])
    assert.deepEqual(cfg.available_methods, ['bank_transfer'])
    assert.equal(cfg.instapay_handle, 'a@instapay', 'the handle is kept so toggling back needs no re-typing')
  })

  test('an enabled but half-filled bank is not offered', () => {
    const cfg = rowsToPaymentConfig([
      { key: 'instapay_handle', value: 'a@instapay' },
      { key: 'bank_transfer_enabled', value: '1' },
      { key: 'bank_name', value: 'Banque Misr' },
    ])
    assert.deepEqual(cfg.available_methods, ['instapay'])
  })

  test('both off leaves nothing payable', () => {
    const cfg = rowsToPaymentConfig([
      { key: 'instapay_handle', value: 'a@instapay' },
      { key: 'instapay_enabled', value: '0' },
      ...BANK_ROWS,
      { key: 'bank_transfer_enabled', value: 'false' },
    ])
    assert.deepEqual(cfg.available_methods, [])
    assert.equal(isPaymentConfigured(cfg), false)
  })
})
