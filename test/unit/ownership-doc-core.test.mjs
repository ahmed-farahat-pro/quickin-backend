// Unit tests for src/lib/local/ownership-doc-core.ts — what a host may attach to
// a listing as proof of ownership.
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and ownership-doc-core.ts has no relative imports, which is
// what makes it loadable here. See the backend README → Testing.
//
// The point of the module is that a deed arrives as a PDF at least as often as a
// photo, so the tests below pin BOTH halves: a real PDF is accepted, and a file
// merely calling itself one is not — the mime in a data URL is attacker-supplied
// text, the `%PDF-` magic number is not.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  OWNERSHIP_DOC_ACCEPT,
  OWNERSHIP_DOC_MAX_CHARS,
  checkOwnershipDoc,
  isOwnershipDocSrc,
  isPdfDataUrl,
  ownershipDocAction,
  ownershipDocProblemMessage,
} from '../../src/lib/local/ownership-doc-core.ts'

/** `%PDF-1.7` in base64 — the opening bytes of any real PDF. */
const PDF = 'data:application/pdf;base64,JVBERi0xLjcK'
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('isPdfDataUrl', () => {
  test('accepts a data URL whose bytes start with the PDF magic number', () => {
    assert.equal(isPdfDataUrl(PDF), true)
    assert.equal(isPdfDataUrl('  DATA:APPLICATION/PDF;BASE64, JVBERi0xLjcK '), true)
  })

  test('refuses a file that only claims to be a PDF', () => {
    // A JPEG, an HTML page and empty bytes relabelled application/pdf.
    assert.equal(isPdfDataUrl('data:application/pdf;base64,/9j/4AAQSkZJRg=='), false)
    assert.equal(isPdfDataUrl('data:application/pdf;base64,PGh0bWw+'), false)
    assert.equal(isPdfDataUrl('data:application/pdf;base64,'), false)
  })

  test('refuses everything that is not a PDF data URL', () => {
    for (const v of [null, undefined, '', JPEG, 'https://example.com/deed.pdf', 'JVBERi0xLjcK', 7]) {
      assert.equal(isPdfDataUrl(v), false)
    }
  })
})

describe('isOwnershipDocSrc', () => {
  test('accepts the three shapes a document is stored in', () => {
    assert.equal(isOwnershipDocSrc(PDF), true)
    assert.equal(isOwnershipDocSrc(JPEG), true)
    assert.equal(isOwnershipDocSrc(PNG), true)
    assert.equal(isOwnershipDocSrc('https://files.example.com/deed.pdf'), true)
    assert.equal(isOwnershipDocSrc('http://files.example.com/deed.jpg'), true)
  })

  test('refuses anything else, including the shapes that used to slip through', () => {
    for (const v of [
      null,
      undefined,
      '',
      '   ',
      'deed.pdf',
      'data:text/html;base64,PGh0bWw+',
      'data:application/msword;base64,QUJD',
      'data:application/pdf;base64,PGh0bWw+', // HTML wearing a PDF label
      'javascript:alert(1)',
      42,
    ]) {
      assert.equal(isOwnershipDocSrc(v), false, `must refuse ${String(v)}`)
    }
  })
})

describe('checkOwnershipDoc', () => {
  test('passes a photo, a PDF and a link', () => {
    for (const v of [JPEG, PNG, PDF, 'https://files.example.com/deed.pdf']) {
      assert.equal(checkOwnershipDoc(v), null, `must accept ${v.slice(0, 32)}`)
    }
  })

  test('nothing attached is `missing`, not `unsupported`', () => {
    for (const v of [null, undefined, '', '   ']) assert.equal(checkOwnershipDoc(v), 'missing')
  })

  test('a file we cannot review is `unsupported`', () => {
    assert.equal(checkOwnershipDoc('data:application/msword;base64,QUJD'), 'unsupported')
    assert.equal(checkOwnershipDoc('data:image/svg+xml;base64,PHN2Zz4='), 'unsupported')
  })

  test('an oversized but valid document is `too_large`, so the host is told which problem to fix', () => {
    const huge = `data:application/pdf;base64,JVBERi0${'A'.repeat(OWNERSHIP_DOC_MAX_CHARS)}`
    assert.equal(checkOwnershipDoc(huge), 'too_large')
    const hugeJpeg = `data:image/jpeg;base64,${'A'.repeat(OWNERSHIP_DOC_MAX_CHARS)}`
    assert.equal(checkOwnershipDoc(hugeJpeg), 'too_large')
  })

  test('a document exactly at the cap is still accepted', () => {
    const prefix = 'data:image/jpeg;base64,'
    const exact = prefix + 'A'.repeat(OWNERSHIP_DOC_MAX_CHARS - prefix.length)
    assert.equal(exact.length, OWNERSHIP_DOC_MAX_CHARS)
    assert.equal(checkOwnershipDoc(exact), null)
  })
})

describe('ownershipDocProblemMessage', () => {
  test('says which of the two things went wrong', () => {
    assert.equal(ownershipDocProblemMessage('too_large'), 'That file is too large')
    assert.equal(ownershipDocProblemMessage('missing'), 'Please attach a photo or PDF of the document')
    assert.equal(ownershipDocProblemMessage('unsupported'), 'Please attach a photo or PDF of the document')
  })

  test('the routes match these strings to answer 400 rather than 500', () => {
    // Mirrors the regexes in POST /api/local/listings and PATCH /api/local/listings/:id.
    for (const p of ['missing', 'unsupported', 'too_large']) {
      assert.match(ownershipDocProblemMessage(p), /attach a photo|too large/i)
    }
  })
})

describe('OWNERSHIP_DOC_ACCEPT', () => {
  test('offers images and PDF to the file picker, and nothing else', () => {
    assert.equal(OWNERSHIP_DOC_ACCEPT, 'image/*,application/pdf')
  })
})

describe('ownershipDocAction', () => {
  test('a listing with a document on file is offered a re-upload', () => {
    assert.equal(ownershipDocAction(true), 'reupload')
  })

  test('a listing that never had one is offered an UPLOAD, not a re-upload', () => {
    // The bug this function exists for: the ownership document is optional at
    // create time, so a listing sits in the queue as 'pending' with nothing
    // attached — and all three host dashboards labelled the button off the
    // moderation status, telling the host to "re-upload" a document they had
    // never uploaded.
    assert.equal(ownershipDocAction(false), 'upload')
  })

  test('an absent flag reads as "no document", so the host is invited to attach one', () => {
    // A client on an older backend gets no `has_ownership_doc` at all. "Upload"
    // is the honest answer to an unknown: it invites the document either way,
    // where "Re-upload" would claim one is already on file.
    assert.equal(ownershipDocAction(undefined), 'upload')
    assert.equal(ownershipDocAction(null), 'upload')
  })

  test('only a real boolean true counts — a truthy JSON value does not', () => {
    // The flag is a Postgres boolean projected straight into JSON. Anything else
    // arriving here means the payload is not what we think it is, and guessing
    // "yes" from it is how a host is told to re-upload nothing again.
    assert.equal(ownershipDocAction('true'), 'upload')
    assert.equal(ownershipDocAction(1), 'upload')
    assert.equal(ownershipDocAction({}), 'upload')
  })
})
