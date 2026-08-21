// Unit tests for src/lib/local/document-core.ts — document access rules and the
// account-verification state machine behind /ops (E1–E4).
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and document-core.ts has no relative imports, which is what
// makes it loadable here. See the backend README → Testing.
//
// The tests that matter most are under "rejects unsafe documents": these bytes are
// streamed straight into an authenticated admin's browser, so an SVG or an HTML
// payload smuggled into an image column must never make it out of the parser.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOCUMENT_KINDS,
  ALLOWED_DOCUMENT_MIME,
  ALLOWED_OWNERSHIP_MIME,
  allowedMimeFor,
  documentFileExtension,
  VERIFICATION_STATUSES,
  VERIFICATION_ACTIONS,
  VERIFICATION_FILTERS,
  DocumentFormatError,
  isDocumentKind,
  idColumnFor,
  owningModuleFor,
  auditTargetTypeFor,
  parseDocumentDataUrl,
  base64ByteLength,
  asDocumentUrl,
  isVerificationAction,
  normalizeVerificationFilter,
  normalizeVerificationStatus,
  statusForAction,
  verifiedAtForStatus,
  verificationLabel,
} from '../../src/lib/local/document-core.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('document kinds', () => {
  test('recognises exactly the six kinds', () => {
    for (const k of DOCUMENT_KINDS) assert.equal(isDocumentKind(k), true)
    assert.equal(DOCUMENT_KINDS.length, 6)
  })

  test('rejects anything else, including SQL-ish input', () => {
    for (const v of [null, undefined, '', 'image_data', 'id_front; DROP TABLE users', 'ID_FRONT', 7]) {
      assert.equal(isDocumentKind(v), false)
    }
  })

  test('idColumnFor maps only the three ID kinds to a column', () => {
    assert.equal(idColumnFor('id_front'), 'image_data')
    assert.equal(idColumnFor('id_back'), 'back_image_data')
    assert.equal(idColumnFor('id_selfie'), 'selfie_image_data')
    // ownership lives on listings, not id_verifications.
    assert.equal(idColumnFor('ownership'), null)
  })

  test('every column name it can return is a bare identifier — it reaches SQL', () => {
    for (const k of DOCUMENT_KINDS) {
      const col = idColumnFor(k)
      if (col !== null) assert.match(col, /^[a-z_]+$/)
    }
  })

  test('owningModuleFor pairs each kind with the queue it belongs to', () => {
    assert.equal(owningModuleFor('id_front'), 'verifications')
    assert.equal(owningModuleFor('id_back'), 'verifications')
    assert.equal(owningModuleFor('id_selfie'), 'verifications')
    assert.equal(owningModuleFor('ownership'), 'listings')
  })

  test('auditTargetTypeFor keys the audit row on the subject, not the document', () => {
    // 'everything opened about this user' must be one indexed lookup.
    assert.equal(auditTargetTypeFor('id_front'), 'user')
    assert.equal(auditTargetTypeFor('id_back'), 'user')
    assert.equal(auditTargetTypeFor('id_selfie'), 'user')
    assert.equal(auditTargetTypeFor('ownership'), 'listing')
  })
})

describe('parseDocumentDataUrl — accepts valid documents', () => {
  test('splits mime and payload', () => {
    assert.deepEqual(parseDocumentDataUrl(PNG), { mime: 'image/png', base64: 'iVBORw0KGgo=' })
  })

  test('accepts every allowlisted mime', () => {
    for (const mime of ALLOWED_DOCUMENT_MIME) {
      assert.equal(parseDocumentDataUrl(`data:${mime};base64,QUJD`).mime, mime)
    }
  })

  test('normalises image/jpg to image/jpeg so a legit upload is not refused', () => {
    assert.equal(parseDocumentDataUrl('data:image/jpg;base64,QUJD').mime, 'image/jpeg')
  })

  test('is case-insensitive on the mime and tolerates stray whitespace', () => {
    assert.equal(parseDocumentDataUrl('data:IMAGE/PNG;base64,QUJD').mime, 'image/png')
    assert.equal(parseDocumentDataUrl('  data:image/png;base64, QU JD  ').base64, 'QUJD')
  })
})

describe('parseDocumentDataUrl — PDF, for ownership documents only', () => {
  const PDF = 'data:application/pdf;base64,JVBERi0xLjcK'

  test('an ownership document may be a PDF — a deed is issued as one', () => {
    assert.deepEqual(parseDocumentDataUrl(PDF, 'ownership'), {
      mime: 'application/pdf',
      base64: 'JVBERi0xLjcK',
    })
  })

  test('the ID kinds stay image-only', () => {
    for (const kind of ['id_front', 'id_back', 'id_selfie', 'id_change_front', 'id_change_back']) {
      assert.throws(() => parseDocumentDataUrl(PDF, kind), DocumentFormatError, `${kind} must refuse PDF`)
    }
  })

  test('omitting the kind falls back to the narrower rule, not the wider one', () => {
    assert.throws(() => parseDocumentDataUrl(PDF), DocumentFormatError)
  })

  test('allowedMimeFor hands ownership one extra type and the rest none', () => {
    assert.deepEqual([...allowedMimeFor('ownership')], [...ALLOWED_OWNERSHIP_MIME])
    assert.deepEqual([...allowedMimeFor('id_front')], [...ALLOWED_DOCUMENT_MIME])
    assert.equal(ALLOWED_OWNERSHIP_MIME.length, ALLOWED_DOCUMENT_MIME.length + 1)
  })

  test('an ownership PDF still has to be a real PDF at write time, not read time', () => {
    // parseDocumentDataUrl serves what is stored; ownership-doc-core.ts is what
    // refuses HTML wearing a PDF label before it ever reaches the column.
    assert.equal(parseDocumentDataUrl('data:application/pdf;base64,PGh0bWw+', 'ownership').mime, 'application/pdf')
  })
})

describe('documentFileExtension', () => {
  test('names every allowlisted type so a saved file opens', () => {
    assert.equal(documentFileExtension('image/png'), 'png')
    assert.equal(documentFileExtension('image/jpeg'), 'jpg')
    assert.equal(documentFileExtension('image/gif'), 'gif')
    assert.equal(documentFileExtension('image/webp'), 'webp')
    assert.equal(documentFileExtension('application/pdf'), 'pdf')
  })

  test('every mime the parser can return has an extension', () => {
    for (const mime of ALLOWED_OWNERSHIP_MIME) {
      assert.notEqual(documentFileExtension(mime), 'bin', `${mime} needs an extension`)
    }
  })

  test('falls back rather than guessing', () => {
    assert.equal(documentFileExtension('application/zip'), 'bin')
  })
})

describe('parseDocumentDataUrl — rejects unsafe documents', () => {
  test('SVG is refused even though it is an image', () => {
    assert.throws(
      () => parseDocumentDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='),
      DocumentFormatError,
    )
  })

  test('HTML and JS are refused', () => {
    for (const mime of ['text/html', 'application/javascript', 'text/plain']) {
      assert.throws(() => parseDocumentDataUrl(`data:${mime};base64,QUJD`), DocumentFormatError)
    }
  })

  test('a non-data-URL is refused rather than served', () => {
    for (const v of ['https://evil.example/x.png', '<svg onload=alert(1)>', 'iVBORw0KGgo=']) {
      assert.throws(() => parseDocumentDataUrl(v), DocumentFormatError)
    }
  })

  test('empty / null / whitespace throw instead of yielding empty bytes', () => {
    for (const v of [null, undefined, '', '    ']) {
      assert.throws(() => parseDocumentDataUrl(v), DocumentFormatError)
    }
  })

  test('a data URL with no payload throws', () => {
    assert.throws(() => parseDocumentDataUrl('data:image/png;base64,'), DocumentFormatError)
    assert.throws(() => parseDocumentDataUrl('data:image/png;base64,   '), DocumentFormatError)
  })

  test('non-base64 payload throws', () => {
    assert.throws(() => parseDocumentDataUrl('data:image/png;base64,not*valid!'), DocumentFormatError)
  })

  test('URL-encoded (non-base64) data URLs are refused', () => {
    assert.throws(() => parseDocumentDataUrl('data:image/png,%89PNG'), DocumentFormatError)
  })
})

describe('asDocumentUrl', () => {
  test('recognises a stored https link (normalizeOwnershipDoc allows one)', () => {
    assert.equal(asDocumentUrl('https://cdn.example/doc.pdf'), 'https://cdn.example/doc.pdf')
    assert.equal(asDocumentUrl('  https://cdn.example/doc.pdf  '), 'https://cdn.example/doc.pdf')
  })

  test('refuses anything that is not plain https', () => {
    for (const v of [
      'http://cdn.example/doc.pdf', // no plaintext — the operator's browser would warn
      'javascript:alert(1)',
      'data:image/png;base64,QUJD',
      'https://has a space/x',
      '', null, undefined,
    ]) {
      assert.equal(asDocumentUrl(v), null)
    }
  })
})

describe('base64ByteLength', () => {
  test('accounts for padding', () => {
    assert.equal(base64ByteLength('QUJD'), 3) // "ABC"
    assert.equal(base64ByteLength('QUJDRA=='), 4) // "ABCD"
    assert.equal(base64ByteLength('QUJDREU='), 5) // "ABCDE"
    assert.equal(base64ByteLength(''), 0)
  })
})

describe('verification state machine', () => {
  test('actions and statuses are the expected closed sets', () => {
    assert.deepEqual([...VERIFICATION_ACTIONS], ['verify', 'reject', 'pending'])
    assert.deepEqual([...VERIFICATION_STATUSES], ['unverified', 'pending', 'verified', 'rejected'])
  })

  test('isVerificationAction gates the route body', () => {
    for (const a of VERIFICATION_ACTIONS) assert.equal(isVerificationAction(a), true)
    for (const v of ['approve', 'delete', '', null, 'VERIFY']) assert.equal(isVerificationAction(v), false)
  })

  test('statusForAction — including reopening a decided case', () => {
    assert.equal(statusForAction('verify'), 'verified')
    assert.equal(statusForAction('reject'), 'rejected')
    assert.equal(statusForAction('pending'), 'pending')
  })

  test('only a verified account carries verified_at', () => {
    assert.equal(verifiedAtForStatus('verified'), 'now')
    for (const s of ['unverified', 'pending', 'rejected']) {
      assert.equal(verifiedAtForStatus(s), null, `${s} must clear verified_at`)
    }
  })

  test('normalizeVerificationStatus never invents a verified badge', () => {
    assert.equal(normalizeVerificationStatus('verified'), 'verified')
    assert.equal(normalizeVerificationStatus(' VERIFIED '), 'verified')
    for (const v of [null, undefined, '', 'approved', 'trusted', 'true', 1, {}]) {
      assert.equal(normalizeVerificationStatus(v), 'unverified')
    }
  })

  test('normalizeVerificationFilter defaults to the work list', () => {
    for (const f of VERIFICATION_FILTERS) assert.equal(normalizeVerificationFilter(f), f)
    for (const v of [null, '', 'garbage', 'unverified']) {
      assert.equal(normalizeVerificationFilter(v), 'pending')
    }
  })

  test('labels cover every status', () => {
    assert.equal(verificationLabel('unverified'), 'Not submitted')
    assert.equal(verificationLabel('pending'), 'Pending')
    assert.equal(verificationLabel('verified'), 'Verified')
    assert.equal(verificationLabel('rejected'), 'Rejected')
  })
})
