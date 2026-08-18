// Unit tests for src/lib/local/payout-method-core.ts — the validators behind the
// host's payout method (bank account / InstaPay / wallet).
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. payout-method-core.ts has no relative imports, which is
// what makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  IBAN_LENGTHS,
  MAX_ACCOUNT_NAME_CHARS,
  MAX_INSTAPAY_ADDRESS_CHARS,
  PAYOUT_METHODS,
  WALLET_PROVIDERS,
  formatIban,
  ibanChecksumValid,
  isPayoutMethodError,
  isPayoutReady,
  normalizeAccountName,
  normalizeAccountNumber,
  normalizeBankName,
  normalizeBranch,
  normalizeIban,
  normalizeInstapayAddress,
  normalizePayoutMethod,
  normalizeSwiftBic,
  normalizeWalletNumber,
  normalizeWalletProvider,
  payoutDisplay,
  payoutMethodLabel,
  rowToPayoutMethod,
  validatePayout,
  walletProviderLabel,
} from '../../src/lib/local/payout-method-core.ts'

/** Real-format IBANs (the published specimen values for each country). */
const IBAN_EG = 'EG380019000500000000263180002'
const IBAN_GB = 'GB82WEST12345698765432'
const IBAN_DE = 'DE89370400440532013000'
const IBAN_SA = 'SA0380000000608010167519'

function throwsPayoutError(fn, match) {
  assert.throws(fn, (err) => {
    assert.ok(isPayoutMethodError(err), `expected a PayoutMethodError, got ${err?.name}`)
    if (match) assert.match(err.message, match)
    return true
  })
}

describe('PAYOUT_METHODS', () => {
  test('are the three destinations a host can choose', () => {
    assert.deepEqual(PAYOUT_METHODS.map((m) => m.key), ['bank_account', 'instapay', 'wallet'])
  })

  test('every method has a human label', () => {
    for (const m of PAYOUT_METHODS) assert.equal(payoutMethodLabel(m.key), m.label)
  })

  test('the withdrawn credit-card method is gone, not merely hidden', () => {
    // It could not be paid out without a processor token, so it must not
    // validate as a method any more.
    assert.equal(payoutMethodLabel('credit_card'), '')
    throwsPayoutError(() => normalizePayoutMethod('credit_card'))
  })
})

describe('normalizePayoutMethod', () => {
  test('accepts each of the three', () => {
    assert.equal(normalizePayoutMethod('bank_account'), 'bank_account')
    assert.equal(normalizePayoutMethod('instapay'), 'instapay')
    assert.equal(normalizePayoutMethod('wallet'), 'wallet')
  })

  test('tolerates spacing, dashes and case from a client', () => {
    assert.equal(normalizePayoutMethod('Bank Account'), 'bank_account')
    assert.equal(normalizePayoutMethod('bank-account'), 'bank_account')
    assert.equal(normalizePayoutMethod('  InstaPay '), 'instapay')
  })

  test('throws on an empty choice rather than defaulting', () => {
    throwsPayoutError(() => normalizePayoutMethod(''), /choose how you want to be paid/i)
    throwsPayoutError(() => normalizePayoutMethod(undefined))
  })

  test('throws on an unsupported method and names the options', () => {
    throwsPayoutError(() => normalizePayoutMethod('paypal'), /Bank account, InstaPay, Wallet/)
  })
})

describe('normalizeAccountName', () => {
  test('trims and collapses runs of whitespace', () => {
    assert.equal(normalizeAccountName('  Kareem   El   Adl '), 'Kareem El Adl')
  })

  test('requires a name — a transfer needs a payee', () => {
    throwsPayoutError(() => normalizeAccountName(''), /name on the account/i)
    throwsPayoutError(() => normalizeAccountName('   '))
  })

  test('rejects a single character', () => {
    throwsPayoutError(() => normalizeAccountName('K'), /too short/i)
  })

  test('caps the length', () => {
    assert.equal(normalizeAccountName('a'.repeat(500)).length, MAX_ACCOUNT_NAME_CHARS)
  })
})

describe('normalizeBankName', () => {
  test('is required — an account number with no bank is unpayable', () => {
    throwsPayoutError(() => normalizeBankName(''), /name of your bank/i)
    throwsPayoutError(() => normalizeBankName('B'), /too short/i)
  })

  test('trims and collapses whitespace', () => {
    assert.equal(normalizeBankName('  Banque   Misr '), 'Banque Misr')
  })
})

describe('normalizeBranch', () => {
  test('is optional', () => {
    assert.equal(normalizeBranch(''), '')
    assert.equal(normalizeBranch(null), '')
    assert.equal(normalizeBranch('  Zamalek  '), 'Zamalek')
  })
})

describe('ibanChecksumValid', () => {
  test('accepts the published specimen IBANs', () => {
    for (const iban of [IBAN_EG, IBAN_GB, IBAN_DE, IBAN_SA, 'FR1420041010050500013M02606']) {
      assert.equal(ibanChecksumValid(iban), true, iban)
    }
  })

  test('catches a single mistyped character', () => {
    assert.equal(ibanChecksumValid('GB82WEST12345698765433'), false)
  })

  test('catches a transposition the length check would miss', () => {
    // Same characters, two swapped — the whole reason IBANs carry a checksum.
    assert.equal(ibanChecksumValid('GB82WEST12345698765423'), false)
  })

  test('rejects a shape that is not an IBAN at all', () => {
    assert.equal(ibanChecksumValid('WEST12345698765432'), false)
    assert.equal(ibanChecksumValid(''), false)
  })
})

describe('normalizeIban', () => {
  test('stores one account one way, however it was typed', () => {
    assert.equal(normalizeIban('EG38 0019 0005 0000 0000 2631 8000 2'), IBAN_EG)
    assert.equal(normalizeIban('eg380019000500000000263180002'), IBAN_EG)
    assert.equal(normalizeIban('EG38-0019-0005-0000-0000-2631-8000-2'), IBAN_EG)
  })

  test('is optional here — validatePayout is what requires one identifier', () => {
    assert.equal(normalizeIban(''), '')
    assert.equal(normalizeIban(null), '')
  })

  test('enforces the country length, which the checksum alone would not', () => {
    assert.equal(IBAN_LENGTHS.EG, 29)
    throwsPayoutError(() => normalizeIban('EG3800190005000000002631800'), /EG is 29 characters/)
  })

  test('accepts a country absent from the length table on its checksum alone', () => {
    // Refusing an unlisted country would be worse than allowing it.
    const iban = 'MT84MALT011000012345MTLCAST001S'
    assert.equal(ibanChecksumValid(iban), true)
    assert.equal(normalizeIban(iban), iban)
  })

  test('rejects a bad checksum with wording the host can act on', () => {
    throwsPayoutError(() => normalizeIban('GB82WEST12345698765433'), /doesn't look right/i)
  })

  test('rejects a shape that is not an IBAN', () => {
    throwsPayoutError(() => normalizeIban('1234567890123456'), /two letters and two digits/i)
  })

  test('rejects an impossible length', () => {
    throwsPayoutError(() => normalizeIban('EG3800190'), /right length/i)
    throwsPayoutError(() => normalizeIban(`EG38${'0'.repeat(40)}`), /right length/i)
  })
})

describe('normalizeAccountNumber', () => {
  test('strips separators and upper-cases', () => {
    assert.equal(normalizeAccountNumber(' 1234 5678 9012 '), '123456789012')
    assert.equal(normalizeAccountNumber('12-34-5678'), '12345678')
    assert.equal(normalizeAccountNumber('ab1234567'), 'AB1234567')
  })

  test('is optional', () => {
    assert.equal(normalizeAccountNumber(''), '')
    assert.equal(normalizeAccountNumber(null), '')
  })

  test('rejects punctuation that is not a separator', () => {
    throwsPayoutError(() => normalizeAccountNumber('1234/5678'), /letters and digits/i)
  })

  test('rejects an implausible length', () => {
    throwsPayoutError(() => normalizeAccountNumber('123'), /right length/i)
    throwsPayoutError(() => normalizeAccountNumber('1'.repeat(40)), /right length/i)
  })
})

describe('normalizeSwiftBic', () => {
  test('accepts both the 8 and 11 character forms', () => {
    assert.equal(normalizeSwiftBic('NBEGEGCX'), 'NBEGEGCX')
    assert.equal(normalizeSwiftBic('nbegegcxxxx'), 'NBEGEGCXXXX')
    assert.equal(normalizeSwiftBic(' NBEG EGCX '), 'NBEGEGCX')
  })

  test('is optional — most hosts bank domestically', () => {
    assert.equal(normalizeSwiftBic(''), '')
    assert.equal(normalizeSwiftBic(null), '')
  })

  test('rejects a code of the wrong shape', () => {
    throwsPayoutError(() => normalizeSwiftBic('NBEG1EGCX'), /8 or 11 characters/)
    throwsPayoutError(() => normalizeSwiftBic('NBEGEGC'), /8 or 11 characters/)
  })
})

describe('formatIban', () => {
  test('groups by four, the way a bank prints it', () => {
    assert.equal(formatIban(IBAN_GB), 'GB82 WEST 1234 5698 7654 32')
  })

  test('is idempotent on an already-grouped value', () => {
    assert.equal(formatIban(formatIban(IBAN_GB)), formatIban(IBAN_GB))
  })

  test('is empty when there is no IBAN', () => {
    assert.equal(formatIban(''), '')
    assert.equal(formatIban(null), '')
  })
})

describe('normalizeInstapayAddress', () => {
  test('accepts an InstaPay address and lower-cases it', () => {
    assert.equal(normalizeInstapayAddress('Kareem@instapay'), 'kareem@instapay')
    assert.equal(normalizeInstapayAddress('  kareem.eladl@banquemisr '), 'kareem.eladl@banquemisr')
    assert.equal(normalizeInstapayAddress('kareem-el_adl@instapay'), 'kareem-el_adl@instapay')
  })

  test('requires an address', () => {
    throwsPayoutError(() => normalizeInstapayAddress(''), /enter your instapay address/i)
  })

  test('rejects anything that is not name@handle', () => {
    throwsPayoutError(() => normalizeInstapayAddress('kareem'), /name@instapay/)
    throwsPayoutError(() => normalizeInstapayAddress('@instapay'), /name@instapay/)
    throwsPayoutError(() => normalizeInstapayAddress('kareem@'), /name@instapay/)
    throwsPayoutError(() => normalizeInstapayAddress('kareem instapay'), /name@instapay/)
  })

  test('rejects an over-long address', () => {
    throwsPayoutError(
      () => normalizeInstapayAddress(`${'a'.repeat(MAX_INSTAPAY_ADDRESS_CHARS)}@instapay`),
      /too long/i
    )
  })
})

describe('normalizeWalletNumber', () => {
  test('stores one Egyptian number one way, however it was typed', () => {
    for (const input of [
      '01012345678',
      '+201012345678',
      '00201012345678',
      '+20 101 234 5678',
      '010-1234-5678',
      '(010) 1234 5678',
    ]) {
      assert.equal(normalizeWalletNumber(input), '01012345678', input)
    }
  })

  test('keeps a non-Egyptian number payable rather than refusing it', () => {
    assert.equal(normalizeWalletNumber('+971501234567'), '+971501234567')
  })

  test('requires a number', () => {
    throwsPayoutError(() => normalizeWalletNumber(''), /enter your wallet number/i)
  })

  test('rejects letters', () => {
    throwsPayoutError(() => normalizeWalletNumber('0101234abcd'), /only contain digits/i)
  })

  test('rejects an impossible length', () => {
    throwsPayoutError(() => normalizeWalletNumber('12345'), /right length/i)
  })
})

describe('normalizeWalletProvider', () => {
  test('accepts each listed wallet', () => {
    for (const p of WALLET_PROVIDERS) {
      assert.equal(normalizeWalletProvider(p.key), p.key)
      assert.equal(walletProviderLabel(p.key), p.label)
    }
  })

  test('tolerates spacing and case', () => {
    assert.equal(normalizeWalletProvider('Vodafone Cash'), 'vodafone_cash')
    assert.equal(normalizeWalletProvider('orange-money'), 'orange_money')
  })

  test("falls back to 'other' instead of throwing — the number is what matters", () => {
    assert.equal(normalizeWalletProvider(''), 'other')
    assert.equal(normalizeWalletProvider('some_new_wallet'), 'other')
    assert.equal(normalizeWalletProvider(null), 'other')
  })
})

describe('validatePayout', () => {
  test('a bank account keeps every field, stored whole', () => {
    const record = validatePayout({
      method: 'bank_account',
      account_name: 'Kareem El Adl',
      bank_name: 'Banque Misr',
      iban: 'EG38 0019 0005 0000 0000 2631 8000 2',
      account_number: '1234 5678 9012',
      swift_bic: 'nbegegcx',
      branch: '  Zamalek ',
    })
    assert.deepEqual(record, {
      method: 'bank_account',
      account_name: 'Kareem El Adl',
      account_ref: IBAN_EG,
      bank_name: 'Banque Misr',
      iban: IBAN_EG,
      account_number: '123456789012',
      swift_bic: 'NBEGEGCX',
      branch: 'Zamalek',
      provider: '',
    })
  })

  test('the IBAN is the canonical destination when there is one', () => {
    const record = validatePayout({
      method: 'bank_account',
      account_name: 'Kareem El Adl',
      bank_name: 'Banque Misr',
      iban: IBAN_EG,
      account_number: '123456789012',
    })
    assert.equal(record.account_ref, IBAN_EG)
  })

  test('an account number alone is enough — the host may not know their IBAN', () => {
    const record = validatePayout({
      method: 'bank_account',
      account_name: 'Kareem El Adl',
      bank_name: 'Banque Misr',
      account_number: '123456789012',
    })
    assert.equal(record.iban, '')
    assert.equal(record.account_ref, '123456789012')
  })

  test('an IBAN alone is enough', () => {
    const record = validatePayout({
      method: 'bank_account',
      account_name: 'Kareem El Adl',
      bank_name: 'Banque Misr',
      iban: IBAN_EG,
    })
    assert.equal(record.account_number, '')
    assert.equal(record.account_ref, IBAN_EG)
  })

  test('neither one is a refusal — there would be nothing to pay into', () => {
    throwsPayoutError(
      () => validatePayout({ method: 'bank_account', account_name: 'Kareem El Adl', bank_name: 'Banque Misr' }),
      /IBAN or your account number/i
    )
  })

  test('a bank account without a bank is refused', () => {
    throwsPayoutError(
      () => validatePayout({ method: 'bank_account', account_name: 'Kareem El Adl', iban: IBAN_EG }),
      /name of your bank/i
    )
  })

  test('an InstaPay address is kept whole — it IS the destination', () => {
    const record = validatePayout({
      method: 'instapay',
      account_name: 'Kareem El Adl',
      instapay_address: 'Kareem@instapay',
    })
    assert.equal(record.account_ref, 'kareem@instapay')
    assert.equal(record.provider, '')
    assert.equal(record.iban, '')
    assert.equal(record.bank_name, '')
  })

  test('a wallet keeps its number and provider', () => {
    const record = validatePayout({
      method: 'wallet',
      account_name: 'Kareem El Adl',
      wallet_provider: 'vodafone_cash',
      wallet_number: '+20 101 234 5678',
    })
    assert.equal(record.account_ref, '01012345678')
    assert.equal(record.provider, 'vodafone_cash')
  })

  test('switching method drops the previous method’s fields', () => {
    // A host moving from a bank account to a wallet must not keep a stale IBAN.
    const record = validatePayout({
      method: 'wallet',
      account_name: 'Kareem El Adl',
      bank_name: 'Banque Misr',
      iban: IBAN_EG,
      account_number: '123456789012',
      swift_bic: 'NBEGEGCX',
      branch: 'Zamalek',
      wallet_number: '01012345678',
    })
    assert.equal(record.iban, '')
    assert.equal(record.account_number, '')
    assert.equal(record.bank_name, '')
    assert.equal(record.swift_bic, '')
    assert.equal(record.branch, '')
    assert.equal(record.account_ref, '01012345678')
  })

  test('validates the name before the method-specific fields', () => {
    throwsPayoutError(
      () => validatePayout({ method: 'instapay', account_name: '', instapay_address: 'k@instapay' }),
      /name on the account/i
    )
  })

  test('a bad IBAN is refused outright, so nothing partial is stored', () => {
    throwsPayoutError(
      () =>
        validatePayout({
          method: 'bank_account',
          account_name: 'Kareem El Adl',
          bank_name: 'Banque Misr',
          iban: 'GB82WEST12345698765433',
          account_number: '123456789012',
        }),
      /doesn't look right/i
    )
  })
})

describe('payoutDisplay', () => {
  const bank = {
    method: 'bank_account',
    account_name: 'Kareem El Adl',
    account_ref: IBAN_EG,
    bank_name: 'Banque Misr',
    iban: IBAN_EG,
    account_number: '123456789012',
    swift_bic: '',
    branch: '',
    provider: '',
  }

  test('names the bank and prints the IBAN in readable groups', () => {
    assert.equal(payoutDisplay(bank), 'Banque Misr · EG38 0019 0005 0000 0000 2631 8000 2')
  })

  test('falls back to the account number when there is no IBAN', () => {
    assert.equal(payoutDisplay({ ...bank, iban: '', account_ref: '123456789012' }), 'Banque Misr · 123456789012')
  })

  test('shows an InstaPay address whole — that is how a host checks it', () => {
    assert.equal(
      payoutDisplay({ ...bank, method: 'instapay', account_ref: 'kareem@instapay', bank_name: '', iban: '', account_number: '' }),
      'kareem@instapay'
    )
  })

  test('pairs a wallet number with its provider', () => {
    assert.equal(
      payoutDisplay({ ...bank, method: 'wallet', account_ref: '01012345678', provider: 'vodafone_cash', bank_name: '', iban: '', account_number: '' }),
      'Vodafone Cash · 01012345678'
    )
  })

  test("an 'other' wallet shows just the number, not the word Other", () => {
    assert.equal(
      payoutDisplay({ ...bank, method: 'wallet', account_ref: '01012345678', provider: 'other', bank_name: '', iban: '', account_number: '' }),
      '01012345678'
    )
  })
})

describe('rowToPayoutMethod', () => {
  test('builds the profile view from a database row', () => {
    const view = rowToPayoutMethod({
      method: 'bank_account',
      account_name: 'Kareem El Adl',
      account_ref: IBAN_EG,
      bank_name: 'Banque Misr',
      iban: IBAN_EG,
      account_number: '123456789012',
      swift_bic: 'NBEGEGCX',
      branch: 'Zamalek',
      provider: '',
      updated_at: '2026-06-01T10:00:00.000Z',
    })
    assert.equal(view.method_label, 'Bank account')
    assert.equal(view.iban_formatted, 'EG38 0019 0005 0000 0000 2631 8000 2')
    assert.equal(view.display, 'Banque Misr · EG38 0019 0005 0000 0000 2631 8000 2')
    assert.equal(view.updated_at, '2026-06-01T10:00:00.000Z')
  })

  test('labels a wallet provider, and leaves the other two without one', () => {
    const wallet = rowToPayoutMethod({ method: 'wallet', account_ref: '01012345678', provider: 'we_pay' })
    assert.equal(wallet.provider_label, 'WE Pay')
    const instapay = rowToPayoutMethod({ method: 'instapay', account_ref: 'k@instapay' })
    assert.equal(instapay.provider_label, '')
    const bank = rowToPayoutMethod({ method: 'bank_account', account_ref: IBAN_EG })
    assert.equal(bank.provider_label, '')
  })

  test('reads a missing row as "no payout method"', () => {
    assert.equal(rowToPayoutMethod(null), null)
    assert.equal(rowToPayoutMethod(undefined), null)
  })

  test('ignores a row whose method is not one of the three', () => {
    // A row left on the withdrawn card method must not render as payable.
    assert.equal(rowToPayoutMethod({ method: 'credit_card', account_ref: '4242' }), null)
    assert.equal(rowToPayoutMethod({ method: 'paypal', account_ref: 'k@paypal' }), null)
  })

  test('tolerates the nulls an old row can carry', () => {
    const view = rowToPayoutMethod({
      method: 'instapay', account_ref: 'k@instapay', account_name: null,
      bank_name: null, iban: null, account_number: null, swift_bic: null,
      branch: null, provider: null, updated_at: null,
    })
    assert.equal(view.account_name, '')
    assert.equal(view.bank_name, '')
    assert.equal(view.iban_formatted, '')
    assert.equal(view.updated_at, null)
  })
})

describe('isPayoutReady', () => {
  test('is true only once there is somewhere to send the money', () => {
    assert.equal(isPayoutReady(rowToPayoutMethod({ method: 'instapay', account_ref: 'k@instapay' })), true)
    assert.equal(isPayoutReady(rowToPayoutMethod({ method: 'bank_account', account_ref: IBAN_EG })), true)
    assert.equal(isPayoutReady(null), false)
    assert.equal(isPayoutReady(undefined), false)
    // A row that somehow lost its destination is not payable either.
    assert.equal(isPayoutReady(rowToPayoutMethod({ method: 'instapay', account_ref: '' })), false)
  })
})
