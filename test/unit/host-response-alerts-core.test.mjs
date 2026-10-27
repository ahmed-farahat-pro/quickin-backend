// Host response alerts — the pure rules behind the nightly sweep and the /ops queue.
// Offline: no database, no network. Run with `npm test`.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_AFTER_HOURS,
  NUDGE_MIN_GAP_HOURS,
  ALERT_STATUSES,
  LIST_FILTERS,
  normalizeListFilter,
  statusesFor,
  cairoDate,
  staleCutoff,
  isStale,
  hoursWaiting,
  shouldNudge,
  closureFor,
  closedReasonLabel,
  HostAlertInputError,
  HANDLED_NOTE_MAX,
  normalizeHandledNote,
  nudgeCopy,
} from '../../src/lib/local/host-response-alerts-core.ts'

const H = 3_600_000
// 01:00 UTC on 22 Oct 2026 — the cron's slot.
const NOW = Date.parse('2026-10-22T01:00:00Z')

describe('staleness', () => {
  test('the threshold is 24 hours', () => {
    assert.equal(STALE_AFTER_HOURS, 24)
    assert.equal(staleCutoff(NOW).getTime(), NOW - 24 * H)
  })

  test('exactly 24h old is stale; one minute short is not', () => {
    assert.equal(isStale(new Date(NOW - 24 * H).toISOString(), NOW), true)
    assert.equal(isStale(new Date(NOW - 24 * H + 60_000).toISOString(), NOW), false)
    assert.equal(isStale(new Date(NOW - 50 * H), NOW), true)
  })

  test('missing or unreadable timestamps are never stale', () => {
    assert.equal(isStale(null, NOW), false)
    assert.equal(isStale(undefined, NOW), false)
    assert.equal(isStale('not a date', NOW), false)
  })

  test('hoursWaiting floors, and never goes negative', () => {
    assert.equal(hoursWaiting(new Date(NOW - 31.9 * H), NOW), 31)
    assert.equal(hoursWaiting(new Date(NOW + 5 * H), NOW), 0)
    assert.equal(hoursWaiting(null, NOW), 0)
  })
})

describe('cairoDate', () => {
  test('is the Cairo calendar day, not UTC', () => {
    // 22:30 UTC on 21 Oct is already 22 Oct in Cairo (UTC+2 or +3).
    assert.equal(cairoDate(Date.parse('2026-10-21T22:30:00Z')), '2026-10-22')
    assert.equal(cairoDate(Date.parse('2026-10-21T20:00:00Z')), '2026-10-21')
  })

  test('formats as YYYY-MM-DD', () => {
    assert.match(cairoDate(NOW), /^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('shouldNudge', () => {
  test('a host never reminded is due', () => {
    assert.equal(shouldNudge(null, NOW), true)
    assert.equal(shouldNudge('garbage', NOW), true)
  })

  test('at most one reminder per night, even if the cron re-runs', () => {
    assert.equal(shouldNudge(new Date(NOW - 10 * 60_000), NOW), false)
    assert.equal(shouldNudge(new Date(NOW - 19 * H), NOW), false)
  })

  test('a cron that fires a little early the next night still nudges', () => {
    // Vercel fires "within the hour", so consecutive runs can be <24h apart.
    assert.ok(NUDGE_MIN_GAP_HOURS < 24)
    assert.equal(shouldNudge(new Date(NOW - 23.2 * H), NOW), true)
  })
})

describe('closureFor', () => {
  const today = '2026-10-22'

  test('a pending request with a future or same-day check-in stays open', () => {
    assert.equal(closureFor({ status: 'pending', checkIn: '2026-10-30' }, today), null)
    assert.equal(closureFor({ status: 'pending', checkIn: today }, today), null)
  })

  test('a pending request whose check-in passed expires', () => {
    assert.deepEqual(
      closureFor({ status: 'pending', checkIn: '2026-10-21' }, today),
      { status: 'expired', reason: 'check_in_passed' },
    )
  })

  test('any answer resolves it, with the booking status as the reason', () => {
    for (const s of ['confirmed', 'rejected', 'cancelled', 'completed']) {
      assert.deepEqual(closureFor({ status: s, checkIn: '2026-10-30' }, today), { status: 'resolved', reason: s })
    }
  })

  test('an answered request resolves even when its check-in has also passed', () => {
    assert.equal(closureFor({ status: 'confirmed', checkIn: '2026-10-01' }, today)?.status, 'resolved')
  })

  test('a timestamp-shaped check-in is compared by its date', () => {
    assert.equal(closureFor({ status: 'pending', checkIn: '2026-10-22T00:00:00Z' }, today), null)
  })
})

describe('filters', () => {
  test('unknown filters fall back to open', () => {
    assert.equal(normalizeListFilter('nope'), 'open')
    assert.equal(normalizeListFilter(undefined), 'open')
    assert.equal(normalizeListFilter(' HANDLED '), 'handled')
  })

  test('every filter selects real statuses, and all covers every status', () => {
    for (const f of LIST_FILTERS) {
      for (const s of statusesFor(f)) assert.ok(ALERT_STATUSES.includes(s))
    }
    assert.deepEqual(statusesFor('closed'), ['resolved', 'expired'])
    assert.deepEqual(new Set(statusesFor('all')), new Set(ALERT_STATUSES))
  })
})

describe('normalizeHandledNote', () => {
  test('trims and collapses whitespace', () => {
    assert.equal(normalizeHandledNote('  called   the\nhost '), 'called the host')
  })

  test('is required', () => {
    assert.throws(() => normalizeHandledNote('   '), HostAlertInputError)
    assert.throws(() => normalizeHandledNote(null), HostAlertInputError)
  })

  test('is capped', () => {
    assert.equal(normalizeHandledNote('a'.repeat(HANDLED_NOTE_MAX)).length, HANDLED_NOTE_MAX)
    assert.throws(() => normalizeHandledNote('a'.repeat(HANDLED_NOTE_MAX + 1)), HostAlertInputError)
  })
})

describe('copy', () => {
  test('the reminder names the listing and how long the guest has waited', () => {
    const c = nudgeCopy('Sea View Chalet', 30)
    assert.match(c.body, /Sea View Chalet/)
    assert.match(c.body, /30 hours/)
    assert.match(nudgeCopy('X', 75).body, /3 days/)
    assert.match(nudgeCopy(null, 25).body, /your listing/)
  })

  test('every closed reason the sweep writes has a label', () => {
    for (const r of ['confirmed', 'completed', 'rejected', 'cancelled', 'check_in_passed']) {
      assert.ok(closedReasonLabel(r).length > 0)
      assert.notEqual(closedReasonLabel(r), r)
    }
    assert.equal(closedReasonLabel(null), '')
  })
})
