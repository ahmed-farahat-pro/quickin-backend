// Unit tests for src/lib/local/xlsx.ts — the Excel serializer behind the B4 export.
//
// Offline: no database, no network. Unlike the *-core modules this one has a real
// dependency (write-excel-file), so it is imported for what it is — a thin wrapper
// whose contract is "produces a genuine .xlsx with the right cell types".
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toXlsx, toCell, attachmentName } from '../../src/lib/local/xlsx.ts'

/** An .xlsx is a ZIP archive, so it must begin with the local-file-header magic. */
const isXlsx = (buf) => buf.subarray(0, 2).toString('latin1') === 'PK'

describe('toXlsx', () => {
  test('produces a real xlsx archive', async () => {
    const buf = await toXlsx(['Resort', 'Total'], [['Marassi', 1234]])
    assert.ok(Buffer.isBuffer(buf), 'returns a Buffer')
    assert.ok(isXlsx(buf), 'starts with the ZIP magic PK')
    assert.ok(buf.length > 500, 'not a stub')
  })

  test('handles zero rows — an empty filter must still download', async () => {
    const buf = await toXlsx(['A', 'B'], [])
    assert.ok(isXlsx(buf))
  })


  test('tolerates null, undefined and non-finite numbers', async () => {
    const buf = await toXlsx(['a', 'b', 'c', 'd'], [[null, undefined, NaN, Infinity]])
    assert.ok(isXlsx(buf), 'must not throw on gaps in the data')
  })

  test('writes booleans and strings', async () => {
    const buf = await toXlsx(['flag', 'name'], [[true, 'Amouage']])
    assert.ok(isXlsx(buf))
  })

  test('carries non-Latin text', async () => {
    // Arabic listing titles are real data here, not a hypothetical.
    const buf = await toXlsx(['name'], [['شاليه في مرسى مطروح']])
    assert.ok(isXlsx(buf))
    assert.ok(buf.length > 500)
  })

  test('sanitizes the sheet name — Excel rejects these characters', async () => {
    // Would throw or corrupt the file if passed through verbatim.
    const buf = await toXlsx(['a'], [['x']], { sheetName: 'book/ings:2026?[Q1]' })
    assert.ok(isXlsx(buf))
  })

  test('truncates an over-long sheet name to Excel’s 31-char limit', async () => {
    const buf = await toXlsx(['a'], [['x']], { sheetName: 'x'.repeat(80) })
    assert.ok(isXlsx(buf))
  })

  test('falls back to a default when the sheet name sanitizes to nothing', async () => {
    const buf = await toXlsx(['a'], [['x']], { sheetName: '///' })
    assert.ok(isXlsx(buf))
  })

  test('handles a wide, long sheet without blowing up', async () => {
    const headers = Array.from({ length: 18 }, (_, i) => `col${i}`)
    const rows = Array.from({ length: 500 }, (_, r) => headers.map((_, c) => (c % 2 ? r * c : `v${r}-${c}`)))
    const buf = await toXlsx(headers, rows)
    assert.ok(isXlsx(buf))
  })
})

describe('toCell — the mapping that decides Excel cell types', () => {
  test('numbers become NUMERIC cells, not text', () => {
    // Without the explicit type every number lands as text and SUM() returns 0 in
    // the operator's spreadsheet. This is the single most important line in the file.
    assert.deepEqual(toCell(1234.56), { value: 1234.56, type: Number })
    assert.deepEqual(toCell(0), { value: 0, type: Number })
    assert.deepEqual(toCell(-5), { value: -5, type: Number })
  })

  test('non-finite numbers become blanks rather than #NUM! errors', () => {
    assert.deepEqual(toCell(NaN), { value: null })
    assert.deepEqual(toCell(Infinity), { value: null })
  })

  test('null and undefined become blank cells', () => {
    assert.deepEqual(toCell(null), { value: null })
    assert.deepEqual(toCell(undefined), { value: null })
  })

  test('booleans keep their type', () => {
    assert.deepEqual(toCell(true), { value: true, type: Boolean })
  })

  test('strings stay strings — including numeric-looking ones', () => {
    assert.deepEqual(toCell('Marassi'), { value: 'Marassi', type: String })
    // A reservation code like '0012' must NOT lose its leading zeros to a number cast.
    assert.deepEqual(toCell('0012'), { value: '0012', type: String })
  })
})

describe('attachmentName', () => {
  test('appends the extension', () => {
    assert.equal(attachmentName('quickin-bookings', 'csv'), 'quickin-bookings.csv')
    assert.equal(attachmentName('quickin-bookings', 'xlsx'), 'quickin-bookings.xlsx')
  })

  test('strips characters that would break Content-Disposition', () => {
    // A quote or comma in the filename breaks the header in some browsers.
    assert.equal(attachmentName('report "Q1", final', 'csv'), 'report-Q1-final.csv')
    assert.equal(attachmentName('a/b\\c', 'csv'), 'a-b-c.csv')
  })

  test('keeps dates and dashes readable', () => {
    assert.equal(attachmentName('quickin-bookings-2026-01-01-to-2026-03-31', 'xlsx'),
      'quickin-bookings-2026-01-01-to-2026-03-31.xlsx')
  })

  test('falls back when the base sanitizes to nothing', () => {
    assert.equal(attachmentName('///', 'csv'), 'report.csv')
    assert.equal(attachmentName('', 'csv'), 'report.csv')
  })
})
