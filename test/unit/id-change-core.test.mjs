// Unit tests for src/lib/local/id-change-core.ts — the rules behind a request to
// change the ID number on a profile.
//
// What these are really guarding: `users.id_document` used to be a plain editable
// field any account could PATCH over, reviewed by nobody. It is now written only by an
// approved request, and this module is what decides which requests are even coherent.
// The two rules worth breaking a build over are that a request must carry a document
// (assertReviewable) and that a rejection must carry a reason (assertRejectionExplained)
// — without either, the review is theatre and the queue may as well not exist.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. id-change-core.ts has no relative imports, which is what makes
// it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ID_CHANGE_ACTIONS,
  ID_CHANGE_STATUSES,
  MAX_DOCUMENT_NUMBER_CHARS,
  MAX_ID_CHANGE_IMAGE_CHARS,
  MAX_ID_CHANGE_NOTE_CHARS,
  MAX_ID_CHANGE_REASON_CHARS,
  MIN_DOCUMENT_NUMBER_CHARS,
  NATIONAL_ID_DIGITS,
  assertActuallyChanges,
  assertRejectionExplained,
  assertReviewable,
  canRequestIdChange,
  canonicalDocumentNumber,
  idChangeStatusLabel,
  isIdChangeError,
  normalizeDocumentImage,
  normalizeDocumentNumber,
  normalizeIdChangeAction,
  normalizeIdChangeNote,
  normalizeIdChangeReason,
  normalizeIdChangeStatus,
  statusForIdChangeAction,
} from '../../src/lib/local/id-change-core.ts'

const VALID_NATIONAL_ID = '29801011234567'
const PNG = 'data:image/png;base64,iVBORw0KGgo='

/** Every throw from this module must be an IdChangeError, so routes answer 400 not 500. */
function assertRejects(fn, matching) {
  assert.throws(fn, (err) => {
    assert.equal(isIdChangeError(err), true, `expected an IdChangeError, got ${err?.name}`)
    if (matching) assert.match(err.message, matching)
    return true
  })
}

describe('canonicalDocumentNumber', () => {
  test('upper-cases and strips the spacing people type for readability', () => {
    assert.equal(canonicalDocumentNumber('a123-456 789'), 'A123456789')
    assert.equal(canonicalDocumentNumber('  x 1  '), 'X1')
  })

  test('absent input canonicalises to empty rather than "null" or "undefined"', () => {
    for (const v of [null, undefined, '']) assert.equal(canonicalDocumentNumber(v), '')
  })
})

describe('normalizeDocumentNumber — national ID', () => {
  test('accepts exactly 14 digits', () => {
    assert.equal(NATIONAL_ID_DIGITS, 14)
    assert.equal(normalizeDocumentNumber(VALID_NATIONAL_ID, 'national_id'), VALID_NATIONAL_ID)
  })

  test('accepts one typed with separators, storing the canonical form', () => {
    assert.equal(normalizeDocumentNumber('298 0101 1234567', 'national_id'), VALID_NATIONAL_ID)
  })

  test('refuses the truncated and transposed numbers a free-text field used to accept', () => {
    assertRejects(() => normalizeDocumentNumber('2980101123456', 'national_id'), /14 digits/)
    assertRejects(() => normalizeDocumentNumber('298010112345678', 'national_id'), /14 digits/)
  })

  test('refuses letters — a national ID is digits only', () => {
    assertRejects(() => normalizeDocumentNumber('2980101123456A', 'national_id'), /digits only/)
  })
})

describe('normalizeDocumentNumber — passport and residence permit', () => {
  test('accepts alphanumeric within the bounds', () => {
    assert.equal(normalizeDocumentNumber('a12345678', 'passport'), 'A12345678')
    assert.equal(normalizeDocumentNumber('rp-998877', 'residence_permit'), 'RP998877')
  })

  test('enforces the length bounds', () => {
    assertRejects(() => normalizeDocumentNumber('A1', 'passport'), /between/)
    assertRejects(
      () => normalizeDocumentNumber('A'.repeat(MAX_DOCUMENT_NUMBER_CHARS + 1), 'passport'),
      /between/,
    )
    assert.equal(
      normalizeDocumentNumber('A'.repeat(MIN_DOCUMENT_NUMBER_CHARS), 'passport').length,
      MIN_DOCUMENT_NUMBER_CHARS,
    )
  })

  test('refuses punctuation that is neither a space nor a dash', () => {
    assertRejects(() => normalizeDocumentNumber('AB_123456', 'passport'), /letters and numbers/)
    assertRejects(() => normalizeDocumentNumber("AB'123456", 'passport'), /letters and numbers/)
  })

  test('an unknown doc type falls back to the generic bounds instead of refusing', () => {
    // Adding a type to host-verification-core's DOC_TYPES must never brick this queue.
    assert.equal(normalizeDocumentNumber('AB123456', 'drivers_licence'), 'AB123456')
    assert.equal(normalizeDocumentNumber('AB123456', undefined), 'AB123456')
  })

  test('refuses an empty number outright', () => {
    for (const v of ['', '   ', null, undefined]) {
      assertRejects(() => normalizeDocumentNumber(v, 'passport'), /enter the number/)
    }
  })
})

describe('assertActuallyChanges', () => {
  test('refuses a request for the value already on file', () => {
    assertRejects(() => assertActuallyChanges(VALID_NATIONAL_ID, VALID_NATIONAL_ID), /already/)
  })

  test('compares canonically — reformatting the same number is not a change', () => {
    assertRejects(() => assertActuallyChanges('a123-456', 'A123 456'), /already/)
  })

  test('allows a real change, and allows any value when nothing is on file', () => {
    assert.doesNotThrow(() => assertActuallyChanges(VALID_NATIONAL_ID, '29801011234568'))
    assert.doesNotThrow(() => assertActuallyChanges(null, VALID_NATIONAL_ID))
    assert.doesNotThrow(() => assertActuallyChanges('', VALID_NATIONAL_ID))
  })
})

describe('assertReviewable — the rule that keeps the queue honest', () => {
  test('refuses a request with no document to check the number against', () => {
    for (const v of [null, undefined, '']) {
      assertRejects(() => assertReviewable(v), /photo of the front/)
    }
  })

  test('accepts one that carries a front image', () => {
    assert.doesNotThrow(() => assertReviewable(PNG))
  })
})

describe('normalizeDocumentImage', () => {
  test('passes through a data URL and an https URL unchanged', () => {
    assert.equal(normalizeDocumentImage(PNG, 'Front'), PNG)
    assert.equal(normalizeDocumentImage('https://cdn.example/x.jpg', 'Front'), 'https://cdn.example/x.jpg')
  })

  test('wraps the bare base64 body the mobile pickers produce', () => {
    assert.equal(normalizeDocumentImage('iVBORw0KGgo=', 'Front'), 'data:image/jpeg;base64,iVBORw0KGgo=')
  })

  test('strips the newlines a wrapped base64 body carries', () => {
    assert.equal(normalizeDocumentImage('iVBO\nRw0K\nGgo=', 'Front'), 'data:image/jpeg;base64,iVBORw0KGgo=')
  })

  test('absent input is null, not an error — the back is optional', () => {
    for (const v of [null, undefined, '', '   ', 42]) {
      assert.equal(normalizeDocumentImage(v, 'Back'), null)
    }
  })

  test('refuses one too large for the column, naming the slot', () => {
    const huge = `data:image/png;base64,${'A'.repeat(MAX_ID_CHANGE_IMAGE_CHARS)}`
    assertRejects(() => normalizeDocumentImage(huge, 'The front of your document'), /front of your document is too large/)
  })
})

describe('reason and note text', () => {
  test('trims, and empty becomes null so the column stays honest', () => {
    assert.equal(normalizeIdChangeReason('  fixed a typo '), 'fixed a typo')
    for (const v of ['', '   ', null, undefined, 7]) {
      assert.equal(normalizeIdChangeReason(v), null)
      assert.equal(normalizeIdChangeNote(v), null)
    }
  })

  test('enforces its own ceiling on each', () => {
    assertRejects(() => normalizeIdChangeReason('x'.repeat(MAX_ID_CHANGE_REASON_CHARS + 1)), /under/)
    assertRejects(() => normalizeIdChangeNote('x'.repeat(MAX_ID_CHANGE_NOTE_CHARS + 1)), /under/)
    assert.equal(normalizeIdChangeReason('x'.repeat(MAX_ID_CHANGE_REASON_CHARS)).length, MAX_ID_CHANGE_REASON_CHARS)
  })
})

describe('statuses and actions', () => {
  test('the catalogs are what the schema and the UI assume', () => {
    assert.deepEqual([...ID_CHANGE_STATUSES], ['pending', 'approved', 'rejected'])
    assert.deepEqual([...ID_CHANGE_ACTIONS], ['approve', 'reject'])
  })

  test('an unknown stored status reads as pending — the state that offers nothing', () => {
    assert.equal(normalizeIdChangeStatus('approved'), 'approved')
    assert.equal(normalizeIdChangeStatus('APPROVED'), 'approved')
    for (const v of ['nonsense', '', null, undefined]) {
      assert.equal(normalizeIdChangeStatus(v), 'pending')
    }
  })

  test('an unknown ACTION throws instead of defaulting — there is no safe default decision', () => {
    assert.equal(normalizeIdChangeAction('APPROVE'), 'approve')
    for (const v of ['pending', 'delete', '', null, undefined]) {
      assertRejects(() => normalizeIdChangeAction(v), /action must be one of/)
    }
  })

  test('a decision maps to the status it lands the row in', () => {
    assert.equal(statusForIdChangeAction('approve'), 'approved')
    assert.equal(statusForIdChangeAction('reject'), 'rejected')
  })

  test('every status has a label', () => {
    for (const s of ID_CHANGE_STATUSES) {
      assert.equal(typeof idChangeStatusLabel(s), 'string')
      assert.ok(idChangeStatusLabel(s).length > 0)
    }
  })
})

describe('assertRejectionExplained', () => {
  test('a rejection without a reason is refused — the user would have nothing to act on', () => {
    assertRejects(() => assertRejectionExplained('reject', null), /why the request is being rejected/)
  })

  test('a rejection with a reason, and any approval, pass', () => {
    assert.doesNotThrow(() => assertRejectionExplained('reject', 'The photo was too blurry to read.'))
    assert.doesNotThrow(() => assertRejectionExplained('approve', null))
  })
})

describe('canRequestIdChange', () => {
  test('only a waiting request blocks a new one', () => {
    assert.equal(canRequestIdChange('pending'), false)
  })

  test('a decided request does not — a rejection has to be fixable', () => {
    assert.equal(canRequestIdChange('rejected'), true)
    assert.equal(canRequestIdChange('approved'), true)
  })

  test('having never filed one allows it', () => {
    assert.equal(canRequestIdChange(null), true)
    assert.equal(canRequestIdChange(undefined), true)
    assert.equal(canRequestIdChange(''), true)
  })
})
