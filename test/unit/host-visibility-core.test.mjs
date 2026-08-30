// Unit tests for src/lib/local/host-visibility-core.ts — who took a listing off
// the market, and who is allowed to put it back.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. host-visibility-core.ts has no relative imports, which is
// what makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PUBLISH_RESPECTING_HOST_SQL,
  canDeactivate,
  canReactivate,
  goesLiveOnReactivate,
  hostVisibilityState,
  publishOnApprovalSql,
  reactivateBlock,
  reactivateBlockMessage,
} from '../../src/lib/local/host-visibility-core.ts'

/** A live, approved, nobody-holding-it-down listing. Tests override one field at
 *  a time so each case says exactly which fact it is about. */
const live = (over = {}) => ({
  is_published: true,
  unpublished_by_host: false,
  unpublished_by_admin: false,
  unpublished_by_verification: false,
  approval_status: 'approved',
  ...over,
})

describe('hostVisibilityState', () => {
  test('a published, approved listing is live', () => {
    assert.equal(hostVisibilityState(live()), 'live')
  })

  test('the host’s own takedown reads as deactivated', () => {
    assert.equal(
      hostVisibilityState(live({ is_published: false, unpublished_by_host: true })),
      'deactivated',
    )
  })

  test('deactivated outranks the moderation states', () => {
    // The host deactivated, then edited — which re-queues the listing. The card
    // has to say "deactivated", because that is the reason it will STAY hidden
    // after the queue approves it, and it is what the button acts on.
    for (const approval of ['pending', 'rejected']) {
      assert.equal(
        hostVisibilityState(live({ is_published: false, unpublished_by_host: true, approval_status: approval })),
        'deactivated',
        approval,
      )
    }
  })

  test('the queue and a rejection each speak for themselves', () => {
    assert.equal(hostVisibilityState(live({ is_published: false, approval_status: 'pending' })), 'under_review')
    assert.equal(hostVisibilityState(live({ is_published: false, approval_status: 'rejected' })), 'rejected')
  })

  test('unpublished by someone else, with nothing else to explain it, is blocked', () => {
    // An account block, the identity gate, or a flagless manual /ops takedown.
    assert.equal(hostVisibilityState(live({ is_published: false, unpublished_by_admin: true })), 'blocked')
    assert.equal(hostVisibilityState(live({ is_published: false, unpublished_by_verification: true })), 'blocked')
    assert.equal(hostVisibilityState(live({ is_published: false })), 'blocked')
  })

  test('a missing approval_status reads as approved, not as pending', () => {
    // Legacy rows predate the column. They must not all appear "under review".
    assert.equal(hostVisibilityState({ is_published: true }), 'live')
    assert.equal(hostVisibilityState({ is_published: true, approval_status: null }), 'live')
  })

  test('approval_status is matched case-insensitively', () => {
    assert.equal(hostVisibilityState(live({ is_published: false, approval_status: 'PENDING' })), 'under_review')
  })
})

describe('canDeactivate / canReactivate', () => {
  test('a live listing can be taken down, and not taken down twice', () => {
    assert.equal(canDeactivate(live()), true)
    assert.equal(canDeactivate(live({ unpublished_by_host: true })), false)
  })

  test('a host may deactivate a listing that is already hidden for another reason', () => {
    // Not a no-op: it is how a host says "do not put this back in front of guests
    // when you approve it", and the approval write honours the flag.
    assert.equal(canDeactivate(live({ is_published: false, approval_status: 'pending' })), true)
    assert.equal(canDeactivate(live({ is_published: false, unpublished_by_admin: true })), true)
  })

  test('a host may only re-publish what the host themselves hid', () => {
    assert.equal(canReactivate(live({ unpublished_by_host: true })), true)
    // The rule that makes the FLAGLESS operator takedown safe: /ops unpublishing
    // by hand writes no flag, so the host has nothing to reactivate.
    assert.equal(canReactivate(live({ is_published: false })), false)
    assert.equal(canReactivate(live({ is_published: false, unpublished_by_admin: true })), false)
    assert.equal(canReactivate(live()), false)
  })
})

describe('reactivateBlock', () => {
  const hidden = (over = {}) => live({ is_published: false, unpublished_by_host: true, ...over })

  test('nothing else holding it down → no block, and it goes live', () => {
    assert.equal(reactivateBlock(hidden()), null)
    assert.equal(goesLiveOnReactivate(hidden()), true)
  })

  test('each other party is reported, and none of them let it go live', () => {
    const cases = [
      [{ unpublished_by_verification: true }, 'verification'],
      [{ unpublished_by_admin: true }, 'staff'],
      [{ approval_status: 'rejected' }, 'rejected'],
      [{ approval_status: 'pending' }, 'under_review'],
    ]
    for (const [over, expected] of cases) {
      assert.equal(reactivateBlock(hidden(over)), expected, expected)
      assert.equal(goesLiveOnReactivate(hidden(over)), false, expected)
    }
  })

  test('the identity gate is reported ahead of an account block', () => {
    // Both hold it; the host is told about the one they can act on.
    assert.equal(
      reactivateBlock(hidden({ unpublished_by_admin: true, unpublished_by_verification: true })),
      'verification',
    )
  })

  test('a staff block outranks the queue', () => {
    assert.equal(reactivateBlock(hidden({ unpublished_by_admin: true, approval_status: 'pending' })), 'staff')
  })

  test('every block has a sentence, and an unblocked reactivate has none', () => {
    for (const block of ['verification', 'staff', 'rejected', 'under_review']) {
      assert.ok(reactivateBlockMessage(block).length > 0, block)
    }
    assert.equal(reactivateBlockMessage(null), '')
  })
})

describe('the SQL guards', () => {
  test('approving only publishes when the host has not taken the listing down', () => {
    const sql = publishOnApprovalSql('$3')
    assert.equal(sql, '($3 AND NOT COALESCE(unpublished_by_host, false))')
  })

  test('a staff publish is conditioned on the same flag', () => {
    assert.equal(PUBLISH_RESPECTING_HOST_SQL, '(NOT COALESCE(unpublished_by_host, false))')
  })

  test('both guards COALESCE, so a NULL flag cannot swallow the publish', () => {
    // Postgres three-valued logic: `NOT NULL` is NULL, and `is_published = NULL`
    // would leave the row hidden forever. The column is NOT NULL DEFAULT false,
    // but the guard must not depend on that.
    for (const sql of [publishOnApprovalSql('$1'), PUBLISH_RESPECTING_HOST_SQL]) {
      assert.match(sql, /COALESCE\(unpublished_by_host, false\)/)
    }
  })
})
