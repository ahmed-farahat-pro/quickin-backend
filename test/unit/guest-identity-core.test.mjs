// Guest identity in /ops — masking, which ID number wins, and how a guest's uploads
// are listed for the audited document channel. See src/lib/local/guest-identity-core.ts.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  docTypeLabel,
  listGuestFiles,
  maskTail,
  parsePhotoIndex,
  pickIdNumber,
} from '../../src/lib/local/guest-identity-core.ts'
import { isDocumentKind } from '../../src/lib/local/document-core.ts'

describe('maskTail', () => {
  test('keeps the last three characters of a national ID and hides the rest', () => {
    assert.equal(maskTail('29801011234567'), '•••••••••••567')
  })

  test('keeps a phone readable as a phone: + and spaces stay where they are', () => {
    assert.equal(maskTail('+20 100 123 4567'), '+•• ••• ••• •567')
  })

  test('masks a value too short to hide anything entirely', () => {
    assert.equal(maskTail('1234'), '••••')
    assert.equal(maskTail('123456'), '••••••')
    assert.equal(maskTail('1234567'), '••••567')
  })

  test('null for nothing on file — not an empty mask that looks like a value', () => {
    for (const v of [null, undefined, '', '   ']) assert.equal(maskTail(v), null)
  })

  test('never returns the original digits beyond the tail', () => {
    const masked = maskTail('A12345678')
    assert.equal(masked, '••••••678')
    assert.ok(!masked.includes('12345'))
  })
})

describe('pickIdNumber', () => {
  test('the verification number wins over the unreviewed profile field', () => {
    assert.deepEqual(pickIdNumber('111', '222'), { value: '111', source: 'verification' })
  })

  test('falls back to the profile field when no verification carries a number', () => {
    assert.deepEqual(pickIdNumber(null, ' 222 '), { value: '222', source: 'profile' })
    assert.deepEqual(pickIdNumber('  ', '222'), { value: '222', source: 'profile' })
  })

  test('null when neither has one', () => {
    assert.equal(pickIdNumber(null, ''), null)
  })
})

describe('docTypeLabel', () => {
  test('names the known types and falls back to a generic label', () => {
    assert.equal(docTypeLabel('national_id'), 'National ID')
    assert.equal(docTypeLabel('passport'), 'Passport')
    assert.equal(docTypeLabel('residence_permit'), 'Residence permit')
    assert.equal(docTypeLabel(null), 'ID')
    assert.equal(docTypeLabel('drivers_licence'), 'ID')
  })
})

describe('listGuestFiles', () => {
  const rows = {
    verifications: [
      { id: 'v1', status: 'pending', doc_type: 'passport', submitted_at: 't1', has_front: true, has_back: false, has_selfie: true },
    ],
    idChanges: [
      { id: 'c1', status: 'pending', doc_type: 'national_id', submitted_at: 't2', has_front: true, has_back: true },
    ],
    paymentProofs: [
      { id: 'p1', status: 'approved', method: 'bank_transfer', reservation_code: 'QK-1', submitted_at: 't3' },
    ],
    disputes: [
      { id: 'd1', status: 'open', category: 'cleanliness', reservation_code: 'QK-2', created_at: 't4', photo_count: 2 },
      { id: 'd2', status: 'resolved', category: 'other', reservation_code: 'QK-3', created_at: 't5', photo_count: 0 },
    ],
  }
  const files = listGuestFiles(rows)

  test('lists only files that exist: no back for a passport with none, nothing for a photo-less dispute', () => {
    assert.deepEqual(files.map((f) => `${f.kind}:${f.id}${f.n === undefined ? '' : `#${f.n}`}`), [
      'id_front:v1', 'id_selfie:v1',
      'id_change_front:c1', 'id_change_back:c1',
      'payment_proof:p1',
      'dispute_photo:d1#0', 'dispute_photo:d1#1',
    ])
  })

  test('orders identity, then ID-change evidence, then payments, then disputes', () => {
    assert.deepEqual([...new Set(files.map((f) => f.group))], ['identity', 'id_change', 'payment', 'dispute'])
  })

  test('every kind it emits is one the audited document channel serves', () => {
    for (const f of files) assert.equal(isDocumentKind(f.kind), true, f.kind)
  })

  test('labels say what the file is', () => {
    assert.equal(files[0].label, 'Passport — front')
    assert.equal(files[1].label, 'Selfie')
    assert.equal(files[4].label, 'Bank transfer screenshot')
    assert.equal(files[5].label, 'Dispute photo 1 of 2')
  })

  test('carries the reservation code so two similar screenshots can be told apart', () => {
    assert.equal(files[4].context, 'QK-1')
    assert.equal(files[6].context, 'QK-2')
  })

  test('nothing on file lists nothing', () => {
    assert.deepEqual(listGuestFiles({ verifications: [], idChanges: [], paymentProofs: [], disputes: [] }), [])
  })
})

describe('parsePhotoIndex', () => {
  test('accepts small non-negative integers', () => {
    assert.equal(parsePhotoIndex('0'), 0)
    assert.equal(parsePhotoIndex('12'), 12)
  })

  test('refuses anything else', () => {
    for (const v of [null, undefined, '', '-1', '1.5', 'abc', '1; DROP', '10000']) {
      assert.equal(parsePhotoIndex(v), null, String(v))
    }
  })
})
