// Unit tests for src/lib/local/login-row-core.ts — how sign-in resolves an email
// address that owns more than one `users` row.
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and login-row-core.ts has no relative imports, which is what
// makes it loadable here. See README → Testing.
//
// The case that matters most is under "the cross-client contract": an address can own
// several rows because migrate-split-accounts.mjs keyed uniqueness on
// (lower(email), role) rather than email. Both projects used to pick ONE row and only
// then check the password against it, and they picked differently — so the very same
// credentials signed in on the web and were refused with "Invalid email or password"
// on iOS/Android. These tests pin the rule that fixes it: the credentials pick the row.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pickLoginRow, blockedRowAmong, LOGIN_ROW_ORDER_SQL } from '../../src/lib/local/login-row-core.ts'

// Stand-ins for UserRow. `pw` is the plaintext this row's hash would verify.
const row = (id, pw, opts = {}) => ({ id, pw, account_status: 'active', ...opts })
const matches = password => r => r.pw !== null && r.pw === password
const isActive = r => r.account_status === 'active'

describe('pickLoginRow', () => {
  test('returns null when the address owns no rows', () => {
    assert.equal(pickLoginRow([], matches('anything')), null)
  })

  test('single row whose password matches is returned', () => {
    const rows = [row('a', 'correct-horse')]
    assert.equal(pickLoginRow(rows, matches('correct-horse')).id, 'a')
  })

  test('single row with the wrong password still returns the row, not null', () => {
    // The caller re-checks the password and answers 401. Returning null here would
    // make "wrong password" indistinguishable from "no such user" and leak which
    // addresses are registered.
    const rows = [row('a', 'correct-horse')]
    assert.equal(pickLoginRow(rows, matches('wrong')).id, 'a')
  })

  describe('the cross-client contract — duplicate rows per email', () => {
    test('picks the row the password actually belongs to, not the first row', () => {
      // The exact production shape: the canonical role='user' row is first, but the
      // password lives on the host row. The old code checked only the first row and
      // rejected a valid sign-in.
      const rows = [row('user-row', 'not-this-one'), row('host-row', 'real-password')]
      assert.equal(pickLoginRow(rows, matches('real-password')).id, 'host-row')
    })

    test('finds the password on the LAST row of several', () => {
      const rows = [row('a', 'x'), row('b', 'y'), row('c', 'real-password')]
      assert.equal(pickLoginRow(rows, matches('real-password')).id, 'c')
    })

    test('a row with no password_hash never wins', () => {
      // Social-only rows carry password_hash = NULL; they must not swallow a sign-in.
      const rows = [row('social', null), row('email', 'real-password')]
      assert.equal(pickLoginRow(rows, matches('real-password')).id, 'email')
    })

    test('when several rows share the password, caller order decides — deterministically', () => {
      // Stability is the point: the same credentials must resolve to the same account
      // on every request and on both clients, never to whatever the heap returned.
      const rows = [row('canonical', 'same'), row('dupe', 'same')]
      assert.equal(pickLoginRow(rows, matches('same')).id, 'canonical')
      assert.equal(pickLoginRow(rows, matches('same')).id, 'canonical')
    })

    test('no row matches → falls back to the canonical row so the caller answers 401', () => {
      const rows = [row('canonical', 'a'), row('dupe', 'b')]
      assert.equal(pickLoginRow(rows, matches('neither')).id, 'canonical')
    })
  })
})

describe('blockedRowAmong', () => {
  test('all rows active → null, sign-in proceeds', () => {
    assert.equal(blockedRowAmong([row('a', 'x'), row('b', 'y')], isActive), null)
  })

  test('no rows → null', () => {
    assert.equal(blockedRowAmong([], isActive), null)
  })

  test('a block on ANY row refuses the whole address', () => {
    // /ops suspends one row by id. If only the authenticating row were checked, a
    // suspended person could sign in through the sibling row that was never blocked.
    const rows = [row('active-dupe', 'x'), row('blocked', 'y', { account_status: 'blocked' })]
    assert.equal(blockedRowAmong(rows, isActive).id, 'blocked')
  })

  test('a removed row refuses the address too', () => {
    const rows = [row('active-dupe', 'x'), row('gone', 'y', { account_status: 'removed' })]
    assert.equal(blockedRowAmong(rows, isActive).id, 'gone')
  })
})

describe('LOGIN_ROW_ORDER_SQL', () => {
  test("prefers role='user', then oldest, then id for a total order", () => {
    // Ordering is part of the contract: without a total order Postgres may return
    // duplicates in physical order, which is exactly the instability being fixed.
    assert.match(LOGIN_ROW_ORDER_SQL, /^ORDER BY/)
    assert.match(LOGIN_ROW_ORDER_SQL, /\(role = 'user'\) DESC/)
    assert.match(LOGIN_ROW_ORDER_SQL, /created_at NULLS LAST/)
    assert.match(LOGIN_ROW_ORDER_SQL, /, id$/)
  })
})
