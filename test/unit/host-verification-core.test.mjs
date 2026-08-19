// Unit tests for src/lib/local/host-verification-core.ts — the rule that decides
// whether a host may put a listing in front of guests.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. host-verification-core.ts has no relative imports, which
// is what makes it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOC_TYPES,
  VERIFICATION_STATUSES,
  canPublishListing,
  docTypeLabel,
  isHostVerificationError,
  isListingAllowed,
  normalizeDocType,
  needsIdentityDocuments,
  normalizeVerificationStatus,
  revokesListingPrivileges,
} from '../../src/lib/local/host-verification-core.ts'

const verified = { isHost: true, verificationStatus: 'verified' }

describe('canPublishListing', () => {
  test('an approved, verified host may list', () => {
    const r = canPublishListing(verified)
    assert.equal(r.allowed, true)
    assert.equal(r.code, 'ok')
  })

  test('BOTH conditions are required — neither alone is enough', () => {
    // The whole point of the feature: being a host is not being verified.
    assert.equal(canPublishListing({ isHost: true, verificationStatus: 'unverified' }).allowed, false)
    assert.equal(canPublishListing({ isHost: false, verificationStatus: 'verified' }).allowed, false)
    assert.equal(canPublishListing({ isHost: false, verificationStatus: 'unverified' }).allowed, false)
  })

  test('reports not_host FIRST, so a non-host is not sent to the ID screen', () => {
    // Telling someone "verify your ID" before they are a host would send them to
    // a page that cannot unblock them.
    const r = canPublishListing({ isHost: false, verificationStatus: 'rejected' })
    assert.equal(r.code, 'not_host')
  })

  test('distinguishes never-submitted, under-review and rejected', () => {
    assert.equal(canPublishListing({ isHost: true, verificationStatus: 'unverified' }).code, 'verification_missing')
    assert.equal(canPublishListing({ isHost: true, verificationStatus: 'pending' }).code, 'verification_pending')
    assert.equal(canPublishListing({ isHost: true, verificationStatus: 'rejected' }).code, 'verification_rejected')
  })

  test('every refusal carries a non-empty message for the host', () => {
    for (const status of ['unverified', 'pending', 'rejected']) {
      const r = canPublishListing({ isHost: true, verificationStatus: status })
      assert.equal(r.allowed, false)
      assert.ok(r.message.length > 10, `empty message for ${status}`)
    }
    assert.ok(canPublishListing({ isHost: false, verificationStatus: 'verified' }).message.length > 10)
  })

  test('an unknown or missing status is treated as unverified, never as allowed', () => {
    // Fail closed: a typo or a column that has not been backfilled must not
    // silently grant listing rights.
    // NB 'VERIFIED ' is deliberately absent: casing and padding are normalized,
    // not rejected (see the next test). This list is values with no known meaning.
    for (const bad of [null, undefined, '', 'approved', 'yes', 42, {}]) {
      const r = canPublishListing({ isHost: true, verificationStatus: bad })
      assert.equal(r.allowed, false, `allowed for ${JSON.stringify(bad)}`)
    }
  })

  test('the status match is case-insensitive and trimmed', () => {
    assert.equal(canPublishListing({ isHost: true, verificationStatus: ' Verified ' }).allowed, true)
  })

  test('staff bypass the gate', () => {
    const r = canPublishListing({ isHost: false, verificationStatus: 'rejected', isStaff: true })
    assert.equal(r.allowed, true)
  })

  test('isListingAllowed agrees with canPublishListing', () => {
    assert.equal(isListingAllowed(verified), true)
    assert.equal(isListingAllowed({ isHost: true, verificationStatus: 'pending' }), false)
  })
})

describe('normalizeDocType', () => {
  test('accepts every catalogued type', () => {
    for (const d of DOC_TYPES) assert.equal(normalizeDocType(d.key), d.key)
  })

  test('tolerates spacing and casing a form might send', () => {
    assert.equal(normalizeDocType('National ID'), 'national_id')
    assert.equal(normalizeDocType('  PASSPORT '), 'passport')
    assert.equal(normalizeDocType('residence-permit'), 'residence_permit')
  })

  test('throws rather than defaulting — a passport filed as a national ID misleads the reviewer', () => {
    for (const bad of ['', '   ', null, undefined, 'driving_licence', 'id', 7]) {
      assert.throws(() => normalizeDocType(bad), isHostVerificationError, `for ${JSON.stringify(bad)}`)
    }
  })

  test('the missing-value message differs from the unknown-value message', () => {
    const missing = (() => { try { normalizeDocType('') } catch (e) { return e.message } })()
    const unknown = (() => { try { normalizeDocType('nope') } catch (e) { return e.message } })()
    assert.notEqual(missing, unknown)
  })
})

describe('docTypeLabel', () => {
  test('renders a known key', () => {
    assert.equal(docTypeLabel('national_id'), 'National ID')
  })

  test('falls back for legacy rows submitted before doc_type existed', () => {
    assert.equal(docTypeLabel(null), 'Not specified')
    assert.equal(docTypeLabel(''), 'Not specified')
    assert.equal(docTypeLabel('something_old'), 'something_old')
  })
})

describe('normalizeVerificationStatus', () => {
  test('passes through the known statuses', () => {
    for (const s of VERIFICATION_STATUSES) assert.equal(normalizeVerificationStatus(s), s)
  })

  test('anything else is unverified', () => {
    for (const bad of [null, undefined, '', 'approved', 5]) {
      assert.equal(normalizeVerificationStatus(bad), 'unverified')
    }
  })
})

describe('revokesListingPrivileges', () => {
  test('losing verification revokes', () => {
    assert.equal(revokesListingPrivileges('verified', 'rejected'), true)
    assert.equal(revokesListingPrivileges('verified', 'unverified'), true)
  })

  test('re-opening a decided case also revokes', () => {
    // While a case is back under review the host is not verified, and a listing
    // that stayed live through the re-review is exactly the gap this closes.
    assert.equal(revokesListingPrivileges('verified', 'pending'), true)
  })

  test('gaining or keeping verification does not revoke', () => {
    assert.equal(revokesListingPrivileges('pending', 'verified'), false)
    assert.equal(revokesListingPrivileges('verified', 'verified'), false)
  })

  test('a host who was never verified has nothing to revoke', () => {
    assert.equal(revokesListingPrivileges('pending', 'rejected'), false)
    assert.equal(revokesListingPrivileges(null, 'rejected'), false)
  })
})

describe('needsIdentityDocuments', () => {
  test('an applicant with no submission must upload', () => {
    assert.equal(needsIdentityDocuments('unverified'), true)
    assert.equal(needsIdentityDocuments(null), true)
    assert.equal(needsIdentityDocuments(undefined), true)
    // Anything unrecognised reads as 'unverified' — never assume documents exist.
    assert.equal(needsIdentityDocuments('nonsense'), true)
  })

  test('a verified applicant is never asked for the same ID twice', () => {
    // The bug this closes: a guest who verified from their profile was made to
    // photograph the same document again inside the become-a-host flow.
    assert.equal(needsIdentityDocuments('verified'), false)
  })

  test('a submission still under review is enough', () => {
    // It is already in the reviewer's queue and gets decided with the application.
    assert.equal(needsIdentityDocuments('pending'), false)
  })

  test('a rejected submission must be replaced', () => {
    // The reviewer said these documents were not good enough; re-filing the same
    // row would put the same refused photos back in front of them.
    assert.equal(needsIdentityDocuments('rejected'), true)
  })

  test('status is read case- and whitespace-insensitively', () => {
    assert.equal(needsIdentityDocuments('  VERIFIED '), false)
    assert.equal(needsIdentityDocuments('Pending'), false)
  })
})
