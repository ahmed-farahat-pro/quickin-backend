// Unit tests for src/lib/local/analytics-core.ts — the report filter contract,
// the SQL fragments and the money math behind the /ops analytics screens.
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM
// resolver needs the extension, and analytics-core.ts has no relative imports,
// which is what makes it loadable here. See the backend README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  OTHER_RESORT_KEY,
  NO_RESORT_KEY,
  GRANULARITIES,
  DATE_COLUMNS,
  DEFAULT_RANGE_DAYS,
  ReportInputError,
  parseReportFilter,
  buildReportWhere,
  bucketSql,
  dateExpr,
  toDateString,
  refundFor,
  csvCell,
  toCsv,
  PAID_SQL,
  REFUNDED_SQL,
  MONEY_AT_SQL,
} from '../../src/lib/local/analytics-core.ts'

/** Build the `get` callback parseReportFilter expects from a plain object. */
const q = (obj) => (key) => (key in obj ? obj[key] : null)
const NOW = new Date('2026-07-31T12:00:00Z')

describe('parseReportFilter', () => {
  test('defaults to the last 90 days ending today', () => {
    const f = parseReportFilter(q({}), { now: NOW })
    assert.equal(f.to, '2026-07-31')
    assert.equal(f.from, '2026-05-02')
    const days = (Date.parse(f.to) - Date.parse(f.from)) / 86_400_000
    assert.equal(days, DEFAULT_RANGE_DAYS)
  })

  test('accepts explicit dates', () => {
    const f = parseReportFilter(q({ from: '2026-01-01', to: '2026-03-31' }), { now: NOW })
    assert.equal(f.from, '2026-01-01')
    assert.equal(f.to, '2026-03-31')
  })

  test('rejects a reversed range', () => {
    assert.throws(
      () => parseReportFilter(q({ from: '2026-03-31', to: '2026-01-01' }), { now: NOW }),
      ReportInputError
    )
  })

  test('rejects malformed dates', () => {
    for (const bad of ['31-07-2026', '2026-7-1', 'yesterday', '2026-13-01']) {
      assert.throws(() => parseReportFilter(q({ from: bad }), { now: NOW }), ReportInputError, `should reject ${bad}`)
    }
  })

  test('validates region only when a list is supplied', () => {
    const opts = { now: NOW, allowedRegions: ['North Coast', 'Cairo'] }
    assert.equal(parseReportFilter(q({ region: 'Cairo' }), opts).region, 'Cairo')
    assert.throws(() => parseReportFilter(q({ region: 'Atlantis' }), opts), ReportInputError)
    // Without a list, anything passes — values are parameterised, so an unknown
    // region is a wrong answer, never an injection.
    assert.equal(parseReportFilter(q({ region: 'Atlantis' }), { now: NOW }).region, 'Atlantis')
  })

  test('accepts the two resort sentinels and a uuid, rejects anything else', () => {
    const uuid = '11111111-2222-3333-4444-555555555555'
    assert.equal(parseReportFilter(q({ resort: OTHER_RESORT_KEY }), { now: NOW }).resort, OTHER_RESORT_KEY)
    assert.equal(parseReportFilter(q({ resort: NO_RESORT_KEY }), { now: NOW }).resort, NO_RESORT_KEY)
    assert.equal(parseReportFilter(q({ resort: uuid }), { now: NOW }).resort, uuid)
    assert.throws(() => parseReportFilter(q({ resort: 'Marassi' }), { now: NOW }), ReportInputError)
  })

  test('rejects non-uuid host and listing ids', () => {
    assert.throws(() => parseReportFilter(q({ host: 'me' }), { now: NOW }), ReportInputError)
    assert.throws(() => parseReportFilter(q({ listing: '1' }), { now: NOW }), ReportInputError)
  })

  test('granularity defaults to day and is whitelisted', () => {
    assert.equal(parseReportFilter(q({}), { now: NOW }).granularity, 'day')
    for (const g of GRANULARITIES) {
      assert.equal(parseReportFilter(q({ granularity: g }), { now: NOW }).granularity, g)
    }
    assert.throws(() => parseReportFilter(q({ granularity: 'century' }), { now: NOW }), ReportInputError)
  })

  test('blank values are treated as absent, not as errors', () => {
    const f = parseReportFilter(q({ region: '  ', resort: '', host: '' }), { now: NOW })
    assert.equal(f.region, null)
    assert.equal(f.resort, null)
    assert.equal(f.hostId, null)
  })
})

describe('dateExpr — the injection guard', () => {
  test('resolves every whitelisted column', () => {
    for (const c of DATE_COLUMNS) assert.ok(dateExpr(c).length > 0, `${c} must resolve`)
  })

  test('money_at is the refund-safe expression, not a bare column', () => {
    assert.equal(dateExpr('money_at'), MONEY_AT_SQL)
    assert.match(dateExpr('money_at'), /refunded_at/)
  })

  test('throws on anything not whitelisted', () => {
    // This is what stops an attacker-supplied column name reaching the SQL string.
    assert.throws(() => dateExpr('b.created_at; DROP TABLE bookings--'), ReportInputError)
    assert.throws(() => dateExpr('nonsense'), ReportInputError)
  })
})

describe('buildReportWhere', () => {
  const base = parseReportFilter(q({ from: '2026-01-01', to: '2026-03-31' }), { now: NOW })

  test('always emits an inclusive date range as placeholders', () => {
    const { clauses, params } = buildReportWhere(base, 'created_at')
    assert.equal(clauses.length, 2)
    assert.deepEqual(params, ['2026-01-01', '2026-03-31'])
    assert.match(clauses[0], /\$1::date/)
    // The upper bound is exclusive-of-next-day so the whole `to` day is included.
    assert.match(clauses[1], /\$2::date \+ interval '1 day'/)
  })

  test('honours the placeholder offset so it can be spliced into a bigger query', () => {
    const { clauses, params } = buildReportWhere(base, 'created_at', 5)
    assert.match(clauses[0], /\$6/)
    assert.match(clauses[1], /\$7/)
    assert.equal(params.length, 2)
  })

  test('adds one clause and one param per active filter', () => {
    const f = parseReportFilter(
      q({
        from: '2026-01-01',
        to: '2026-03-31',
        region: 'Cairo',
        host: '11111111-2222-3333-4444-555555555555',
        listing: '99999999-8888-7777-6666-555555555555',
      }),
      { now: NOW }
    )
    const { clauses, params } = buildReportWhere(f, 'created_at')
    assert.equal(clauses.length, 5) // 2 date + region + host + listing
    assert.equal(params.length, 5)
    // Placeholders must be sequential with no gaps or repeats.
    const nums = clauses.join(' ').match(/\$\d+/g).map((s) => Number(s.slice(1)))
    assert.deepEqual([...new Set(nums)].sort((a, b) => a - b), [1, 2, 3, 4, 5])
  })

  test('__other__ emits the free-text pair and consumes NO param', () => {
    const f = parseReportFilter(q({ resort: OTHER_RESORT_KEY }), { now: NOW })
    const { clauses, params } = buildReportWhere(f, 'created_at')
    assert.equal(params.length, 2, 'only the two dates')
    assert.ok(clauses.some((c) => /resort_id IS NULL AND l\.resort_name IS NOT NULL/.test(c)))
  })

  test('__none__ emits both-null', () => {
    const f = parseReportFilter(q({ resort: NO_RESORT_KEY }), { now: NOW })
    const { clauses } = buildReportWhere(f, 'created_at')
    assert.ok(clauses.some((c) => /resort_id IS NULL AND l\.resort_name IS NULL/.test(c)))
  })

  test('a real resort id becomes a cast placeholder', () => {
    const uuid = '11111111-2222-3333-4444-555555555555'
    const f = parseReportFilter(q({ resort: uuid }), { now: NOW })
    const { clauses, params } = buildReportWhere(f, 'created_at')
    assert.ok(clauses.some((c) => /l\.resort_id = \$3::uuid/.test(c)))
    assert.equal(params[2], uuid)
  })

  test('no filter value is ever inlined into the SQL text', () => {
    const f = parseReportFilter(q({ region: "Cairo'; DROP TABLE bookings--" }), { now: NOW })
    const { clauses, params } = buildReportWhere(f, 'created_at')
    assert.ok(!clauses.join(' ').includes('DROP TABLE'), 'value must be a placeholder')
    assert.ok(params.includes("Cairo'; DROP TABLE bookings--"))
  })
})

describe('bucketSql', () => {
  test('produces date_trunc for each granularity', () => {
    assert.equal(bucketSql('day', 'b.created_at'), "date_trunc('day', b.created_at)")
    assert.equal(bucketSql('month', 'b.created_at'), "date_trunc('month', b.created_at)")
  })

  test('throws on an unknown granularity', () => {
    assert.throws(() => bucketSql('fortnight', 'b.created_at'), ReportInputError)
  })
})

describe('the paid_at trap constants', () => {
  test('paid/refunded are decided by payment_status, never by paid_at', () => {
    // A refund clears paid_at, so `paid_at IS NOT NULL` silently loses those rows.
    assert.match(PAID_SQL, /payment_status/)
    assert.ok(!/paid_at/.test(PAID_SQL), 'PAID_SQL must not mention paid_at')
    assert.match(REFUNDED_SQL, /refunded/)
    assert.match(REFUNDED_SQL, /voided/)
  })

  test('the money axis falls back past the cleared paid_at', () => {
    assert.match(MONEY_AT_SQL, /paid_at/)
    assert.match(MONEY_AT_SQL, /refunded_at/)
    assert.match(MONEY_AT_SQL, /created_at/)
  })
})

describe('money math', () => {
  // The commission itself is NOT tested here — it lives in commission-core.ts and is
  // covered by commission-core.test.mjs. This module deliberately holds no second
  // definition of the platform's margin; see the note above refundFor().

  test('refund is recomputed from the percentage, never from refund_amount', () => {
    // refund_amount is NULL for every web cancellation, so it can never be trusted.
    assert.equal(refundFor(1000, 100), 1000)
    assert.equal(refundFor(1000, 50), 500)
    assert.equal(refundFor(1000, 0), 0)
    assert.equal(refundFor(1000, null), 0, 'no percentage means no refund')
  })

  test('refund never exceeds the total and never goes negative', () => {
    assert.equal(refundFor(1000, 150), 1000)
    assert.equal(refundFor(1000, -20), 0)
  })

  test('tolerates junk totals', () => {
    assert.equal(refundFor(null, 50), 0)
    assert.equal(refundFor(NaN, 50), 0)
  })
})

describe('csvCell', () => {
  test('leaves simple values bare', () => {
    assert.equal(csvCell('Marassi'), 'Marassi')
    assert.equal(csvCell(42), '42')
    assert.equal(csvCell(0), '0')
  })

  test('empties null and undefined', () => {
    assert.equal(csvCell(null), '')
    assert.equal(csvCell(undefined), '')
  })

  test('quotes commas, quotes and newlines', () => {
    assert.equal(csvCell('a,b'), '"a,b"')
    assert.equal(csvCell('say "hi"'), '"say ""hi"""')
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"')
  })

  test('quotes values with edge whitespace, which would otherwise be eaten', () => {
    assert.equal(csvCell(' padded '), '" padded "')
  })

  test('defuses spreadsheet formula injection', () => {
    // A listing titled =cmd|... would otherwise execute for whoever opens the export.
    assert.equal(csvCell('=1+1'), "'=1+1")
    assert.equal(csvCell('+SUM(A1)'), "'+SUM(A1)")
    assert.equal(csvCell('-2'), "'-2")
    assert.equal(csvCell('@import'), "'@import")
    // No comma/quote/newline in this payload, so RFC-4180 needs no quoting —
    // just the neutralising prefix.
    assert.equal(csvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0")
  })
})

describe('toCsv', () => {
  test('emits a header row then data, CRLF-terminated', () => {
    const out = toCsv(['a', 'b'], [[1, 2], [3, 4]], { withBom: false })
    assert.equal(out, 'a,b\r\n1,2\r\n3,4\r\n')
  })

  test('handles zero rows', () => {
    assert.equal(toCsv(['a', 'b'], [], { withBom: false }), 'a,b\r\n')
  })

  test('prefixes a UTF-8 BOM by default so Excel reads Arabic correctly', () => {
    const out = toCsv(['name'], [['شاليه']])
    assert.equal(out.charCodeAt(0), 0xfeff)
    assert.ok(out.includes('شاليه'))
    // Without the BOM the file starts at the header, not at U+FEFF.
    assert.equal(toCsv(['name'], [['x']], { withBom: false })[0], 'n')
  })

  test('escapes inside rows, not just headers', () => {
    const out = toCsv(['title'], [['Villa, Marassi']], { withBom: false })
    assert.equal(out, 'title\r\n"Villa, Marassi"\r\n')
  })
})
