// Unit tests for src/lib/local/email-core.ts — the address rules behind
// /signup, the signup API route and the auth modal's zod schemas.
//
// Offline: no database, no network. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM resolver
// needs the extension, and email-core.ts has no relative imports, which is what
// makes it loadable here. See the backend README → Testing.
//
// The test that matters most is the one this module was written for: `.con` is
// not a delegated TLD, so `layla@email.con` must be refused. Both checks that
// used to guard signup — `type="email"` and `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` —
// pass it, because a well-formed address and a deliverable one are not the same
// thing. The second half of the file is the mirror image: the ordinary Egyptian
// addresses (`.eg`, `.com.eg`, `.co.uk`, new gTLDs) that a hand-written TLD
// allowlist would have locked out, which is the way this fix fails badly.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_EMAIL_LENGTH,
  TLD_COUNT,
  isKnownTld,
  suggestDomain,
  normalizeEmail,
  emailDomain,
  checkEmail,
  isTrustedEmail,
  isTrustedEmailDomain,
  TRUSTED_DOMAIN_COUNT,
  isValidEmail,
  isDisposableEmail,
  emailProblemMessage,
} from '../../src/lib/local/email-core.ts'

const codeOf = (email) => checkEmail(email)?.code ?? null

describe('the reported bug — invalid domain extensions', () => {
  test('rejects .con, the typo the bug report was filed for', () => {
    const problem = checkEmail('layla@email.con')
    assert.equal(problem?.code, 'unknownTld')
    assert.equal(problem?.tld, 'con')
    assert.equal(isValidEmail('layla@email.con'), false)
  })

  test('rejects the other common .com near-misses', () => {
    for (const tld of ['con', 'cim', 'cmo', 'ocm', 'xom', 'vom', 'comm', 'cpm']) {
      assert.equal(codeOf(`guest@example.${tld}`), 'unknownTld', tld)
    }
  })

  test('rejects near-misses of the other big extensions', () => {
    for (const address of ['a@example.ner', 'a@example.nte', 'a@example.ogr', 'a@example.rog']) {
      assert.equal(codeOf(address), 'unknownTld', address)
    }
  })

  test('rejects an extension that is simply invented', () => {
    assert.equal(codeOf('guest@quickin.notarealtld'), 'unknownTld')
  })

  test('names the extension so the message can quote it back', () => {
    assert.equal(checkEmail('guest@quickin.zzz')?.tld, 'zzz')
  })
})

describe('did-you-mean', () => {
  test('gmail.con suggests gmail.com', () => {
    assert.equal(checkEmail('layla@gmail.con')?.suggestion, 'gmail.com')
  })

  test('a typo in the name half is caught too', () => {
    assert.equal(suggestDomain('gmial.com'), 'gmail.com')
    assert.equal(suggestDomain('hotmial.com'), 'hotmail.com')
    assert.equal(suggestDomain('yahooo.com'), 'yahoo.com')
  })

  test('an unfamiliar domain with a bad extension still gets its extension fixed', () => {
    assert.equal(suggestDomain('my-company.con'), 'my-company.com')
    assert.equal(suggestDomain('elgouna-rentals.ner'), 'elgouna-rentals.net')
  })

  test('never suggests cn (China) for con — the whole reason the search is a short list', () => {
    // `con` is one deletion from `cn` exactly as it is from `com`. Searching the
    // full root zone would answer with whichever it reached first.
    assert.equal(suggestDomain('example.con'), 'example.com')
  })

  test('offers nothing when there is no confident guess', () => {
    assert.equal(suggestDomain('quickin.notarealtld'), null)
    assert.equal(suggestDomain('gmail.com'), null)
    assert.equal(checkEmail('guest@quickin.notarealtld')?.suggestion, undefined)
  })

  test('a rejected address never carries a suggestion equal to what was typed', () => {
    const problem = checkEmail('layla@gmail.con')
    assert.notEqual(problem?.suggestion, 'gmail.con')
  })
})

describe('real addresses are still accepted', () => {
  // A TLD allowlist that is too tight is worse than the bug it fixes: it turns
  // away paying guests with no way to appeal. These are the ones that matter here.
  const accepted = [
    'layla@gmail.com',
    'layla.hassan@outlook.com',
    'layla+booking@gmail.com',
    'guest@quickin.eg',
    'sales@quickin.com.eg',
    'guest@example.co.uk',
    'host@my-chalet.app',
    'hello@studio.photography',
    'someone@sub.domain.example.org',
    "o'neill.style_name@example.net",
    'a@b.io',
    'guest@xn--mgbaam7a8h.xn--wgbh1c', // punycode: امارات.مصر
  ]
  for (const address of accepted) {
    test(address, () => assert.equal(checkEmail(address), null, address))
  }

  test('country-code and new gTLDs are in the snapshot', () => {
    for (const tld of ['eg', 'ae', 'sa', 'uk', 'com', 'net', 'org', 'app', 'dev', 'photography']) {
      assert.equal(isKnownTld(tld), true, tld)
    }
    assert.equal(isKnownTld('COM'), true, 'the check is case-insensitive')
    assert.ok(TLD_COUNT > 1000, 'the root-zone snapshot should hold the whole list')
  })
})

describe('structure', () => {
  test('a malformed address is a format problem, not an extension problem', () => {
    // The distinction is the difference between "check your extension" and
    // "check your address" in front of the guest.
    for (const address of ['layla', 'layla@', '@gmail.com', 'layla@@gmail.com', 'layla @gmail.com']) {
      assert.equal(codeOf(address), 'format', address)
    }
  })

  test('a bare hostname with no dot is refused', () => {
    assert.equal(codeOf('root@localhost'), 'format')
  })

  test('dots may not start, end or double up', () => {
    for (const address of ['.a@gmail.com', 'a.@gmail.com', 'a..b@gmail.com', 'a@gmail..com', 'a@.gmail.com', 'a@gmail.com.']) {
      assert.equal(codeOf(address), 'format', address)
    }
  })

  test('a domain label may not start or end with a hyphen', () => {
    assert.equal(codeOf('a@-gmail.com'), 'format')
    assert.equal(codeOf('a@gmail-.com'), 'format')
    assert.equal(codeOf('a@my-gmail.com'), null)
  })

  test('a numeric or one-letter extension is malformed, not unknown', () => {
    assert.equal(codeOf('a@example.c'), 'format')
    assert.equal(codeOf('a@192.168.0.1'), 'format')
  })

  test('empty is required, not invalid', () => {
    assert.equal(codeOf(''), 'required')
    assert.equal(codeOf('   '), 'required')
    assert.equal(codeOf(null), 'required')
    assert.equal(codeOf(undefined), 'required')
  })

  test('an over-length address is refused at the SMTP limit', () => {
    const long = 'a'.repeat(MAX_EMAIL_LENGTH) + '@gmail.com'
    assert.equal(codeOf(long), 'tooLong')
    assert.equal(codeOf('a'.repeat(65) + '@gmail.com'), 'format', 'local part caps at 64')
    assert.equal(codeOf('a'.repeat(64) + '@gmail.com'), null)
  })

  test('surrounding whitespace and a shouted domain are tolerated', () => {
    assert.equal(codeOf('  Layla@GMAIL.COM  '), null)
    assert.equal(normalizeEmail('  Layla@GMAIL.COM  '), 'Layla@gmail.com')
    assert.equal(emailDomain('Layla@GMAIL.COM'), 'gmail.com')
    assert.equal(emailDomain('nonsense'), '')
  })
})

describe('disposable domains', () => {
  test('still blocked, including through a subdomain', () => {
    assert.equal(isDisposableEmail('a@mailinator.com'), true)
    assert.equal(isDisposableEmail('a@sub.mailinator.com'), true)
    assert.equal(isDisposableEmail('a@gmail.com'), false)
    assert.equal(codeOf('a@mailinator.com'), 'disposable')
  })

  test('is a policy call, so isValidEmail — a shape question — still says yes', () => {
    // resend-otp asks "could this ever have been an address?", not "may this
    // person sign up?". Only the signup route acts on the disposable verdict.
    assert.equal(isValidEmail('a@mailinator.com'), true)
    assert.equal(isValidEmail('a@mailinator.con'), false, 'a bad extension still fails')
  })

  test('the extension is checked before the blocklist', () => {
    // Otherwise the guest fixes the typo and is told a second, different thing.
    assert.equal(codeOf('a@mailinator.con'), 'unknownTld')
  })
})

describe('the copy the API returns', () => {
  test('quotes the extension and the suggestion', () => {
    const message = emailProblemMessage(checkEmail('layla@gmail.con'))
    assert.match(message, /\.con/)
    assert.match(message, /gmail\.com/)
  })

  test('asks the guest to check the address when there is no suggestion', () => {
    const message = emailProblemMessage(checkEmail('a@quickin.notarealtld'))
    assert.match(message, /notarealtld/)
    assert.doesNotMatch(message, /Did you mean/)
  })

  test('every problem code produces a sentence', () => {
    for (const code of ['required', 'format', 'tooLong', 'unknownTld', 'disposable']) {
      assert.ok(emailProblemMessage({ code }).length > 10, code)
    }
  })
})

// The allowlist added 2026-08-19. Two failure modes to guard, pulling opposite
// ways: a temp-mail domain slipping through, and a real guest being locked out.
// The second is the expensive one — a host who cannot sign up never complains,
// they just leave — so most of these tests are about who must still get IN.
describe('the trusted-provider allowlist', () => {
  test('the providers guests actually use are recognised', () => {
    for (const domain of [
      'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com',
      'icloud.com', 'me.com', 'live.com', 'msn.com',
    ]) {
      assert.ok(isTrustedEmailDomain(domain), domain)
      assert.equal(checkEmail(`layla@${domain}`), null, domain)
    }
  })

  test('the regional and legacy variants of those four count too', () => {
    for (const domain of [
      'googlemail.com', 'hotmail.co.uk', 'outlook.sa', 'live.co.uk',
      'yahoo.co.uk', 'ymail.com', 'rocketmail.com', 'yahoo.com.au',
    ]) {
      assert.ok(isTrustedEmailDomain(domain), domain)
    }
  })

  test('Sign in with Apple\'s private relay is trusted', () => {
    // Apple hands us this domain when the user hides their real address. If it
    // is ever refused, our own Apple sign-in cannot create an account.
    assert.ok(isTrustedEmail('a1b2c3@privaterelay.appleid.com'))
    assert.equal(checkEmail('a1b2c3@privaterelay.appleid.com'), null)
  })

  test('Egyptian and Gulf ISP mailboxes are trusted', () => {
    for (const domain of ['link.net', 'tedata.net.eg', 'vodafone.com.eg', 'emirates.net.ae']) {
      assert.ok(isTrustedEmailDomain(domain), domain)
    }
  })

  test('matching is case- and whitespace-insensitive', () => {
    assert.ok(isTrustedEmailDomain('  GMAIL.COM '))
    assert.ok(isTrustedEmail('Layla@GMail.Com'))
    assert.equal(checkEmail(' Layla@GMAIL.COM '), null)
  })

  test('a trailing root dot does not defeat the lookup', () => {
    assert.ok(isTrustedEmailDomain('gmail.com.'))
  })

  test('the list is a fast path, not the policy — company mail still passes', () => {
    // The whole point of allowlist-PLUS-blocklist over allowlist-only: a host
    // signing up with their work address, or a guest with a university one,
    // is not on any provider list and must still get through.
    for (const email of [
      'ahmed@orascom.com',
      'nour@aucegypt.edu',
      'sara@cu.edu.eg',
      'omar@some-tiny-egyptian-isp.com.eg',
    ]) {
      assert.ok(!isTrustedEmail(email), `${email} should not be on the allowlist`)
      assert.equal(checkEmail(email), null, `${email} should still be accepted`)
    }
  })

  test('being off the allowlist does not excuse a fake extension', () => {
    const problem = checkEmail('ahmed@orascom.con')
    assert.equal(problem?.code, 'unknownTld')
  })

  test('temp-mail is still refused, allowlist or not', () => {
    for (const email of [
      'x@mailinator.com',
      'x@sub.mailinator.com',
      'x@yopmail.com',
      'x@10minutemail.com',
      'x@guerrillamail.com',
      'x@trashmail.com',
      'x@minuteinbox.com',
      'x@generator.email',
    ]) {
      assert.equal(checkEmail(email)?.code, 'disposable', email)
    }
  })

  test('a lookalike of a trusted domain is not itself trusted', () => {
    // `gmail.co` is a real, deliverable domain and a classic phish/typo. It is
    // not on the allowlist, so it takes the ordinary path — and because the
    // extension is real, it is accepted rather than refused. The did-you-mean
    // is what catches it at the form, not the validator.
    assert.ok(!isTrustedEmailDomain('gmail.co'))
    assert.equal(suggestDomain('gmail.co'), 'gmail.com')
  })

  test('the allowlist is big enough to be worth having', () => {
    assert.ok(TRUSTED_DOMAIN_COUNT > 150, `only ${TRUSTED_DOMAIN_COUNT} domains`)
  })

  test('no domain is on both the allowlist and the blocklist', () => {
    // A domain in both lists would be silently accepted, because the allowlist
    // short-circuits first. That is a real footgun when the blocklist grows.
    for (const email of ['x@mail.com', 'x@proton.me', 'x@tuta.io', 'x@fastmail.com']) {
      assert.equal(checkEmail(email), null, email)
    }
  })
})
