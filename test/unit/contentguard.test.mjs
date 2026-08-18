// Unit tests for src/lib/local/contentguard.ts — the guard that keeps phone
// numbers, email addresses, social handles and off-platform links out of chat,
// reviews, listings and profiles.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. contentguard.ts has no relative imports, which is what
// makes it loadable here at all. See README → Testing.
//
// Two halves matter equally. The BLOCK cases are the evasions people actually
// try; the ALLOW cases are ordinary guest⇄host chat, and a failure there is
// worse than a miss — it silently stops real conversations. Add to both when
// you touch a pattern.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectContent,
  assertNoContactInfo,
  isContactBlockedError,
  combinesIntoContact,
  containsPhoneNumber,
  containsEmail,
  containsSocialHandle,
  containsExternalUrl,
  fold,
} from '../../src/lib/local/contentguard.ts'

const blocked = (t, surface = 'chat') => inspectContent(t, surface).blocked
const kindOf = (t) => inspectContent(t, 'chat').kind

describe('normalisation', () => {
  test('Arabic-Indic and Eastern Arabic-Indic digits become ASCII', () => {
    assert.equal(fold('٠١٢٣٤٥٦٧٨٩'), '0123456789')
    assert.equal(fold('۰۱۲۳۴۵۶۷۸۹'), '0123456789')
  })

  test('fullwidth and enclosed digits become ASCII', () => {
    assert.equal(fold('０１２３'), '0123')
    assert.equal(fold('⓪①②③'), '0123')
  })

  test('invisible characters are dropped', () => {
    assert.equal(fold('0​1‌0'), '010') // zero-width space / non-joiner
    assert.equal(fold('0­1­0'), '010') // soft hyphen
    assert.equal(fold('0﻿1⁠ 0'.replace(' ', '')), '010') // BOM / word joiner
  })

  test('Cyrillic and Greek lookalikes fold to Latin', () => {
    assert.equal(fold('gmаil'), 'gmail') // Cyrillic а
    assert.equal(fold('ІNSTA'), 'insta') // Cyrillic І
  })
})

describe('phone numbers — blocked', () => {
  const cases = [
    ['plain', '01012345678'],
    ['spaced', '010 123 45 67'],
    ['dashed', '010-123-4567'],
    ['punctuated', '(010)/123/45678'],
    ['underscored', '0_1_0_1_2_3_4_5_6_7_8'],
    ['international +', '+20 100 123 4567'],
    ['international 00', '00201001234567'],
    ['Arabic-Indic', '٠١٠١٢٣٤٥٦٧٨'],
    ['Eastern Arabic-Indic', '۰۱۰۱۲۳۴۵۶۷۸'],
    ['fullwidth', '０１０１２３４５６７８'],
    ['enclosed', '⓪①⓪①②③④⑤⑥⑦⑧'],
    ['zero-width separated', '0​1​0​1​2​3​4​5​6​7​8'],
    ['soft-hyphen separated', '0­1­0­1­2­3­4­5­6­7­8'],
    ['spelled out (EN)', 'my number is zero one zero one two three four five six seven eight'],
    ['spelled out (AR)', 'رقمي صفر واحد صفر واحد اتنين تلاتة اربعة خمسة ستة سبعة تمانية'],
    ['double/triple', 'my number is 0 double 1 double 2 3 4 5 6 7'],
    ['leet with digits', 'o1o12345678'],
    ['all-letter leet + intent', 'my number is OIO IZ34S67'],
    ['contact app + number', 'واتساب ٠١٠١٢٣٤٥٦٧٨'],
    ['spaced single digits', 'call me on 0 1 0 1 2 3 4 5 6 7 8'],
    ['landline', 'tel: 0233334444'],
    // Letters wedged between the groups. No run reaches 8 and every separator is
    // a letter, so only the digit-only reduction sees these.
    ['letter-prefixed groups', 'A0101 S416 M3280'],
    ['letter-separated', '0101x416x3280'],
    ['letters, no spaces', 'a0101s416m3280'],
    ['letters + single digits', 'Call K0 1 0 M1 2 3 A4 5 6 7 8'],
    ['letters, in a bio', 'Villa owner. A0101 S416 M3280. Sea view.'],
    ['letters + Arabic-Indic', 'x٠١٠y١٢٣z٤٥٦٧٨'],
    ['letters + intent, landline', 'my number is x02 y3333 z4444'],
  ]
  for (const [label, text] of cases) {
    test(label, () => assert.ok(containsPhoneNumber(text), `should block: ${text}`))
  }
})

describe('email addresses — blocked', () => {
  const cases = [
    ['plain', 'my email is kareem@gmail.com'],
    ['spelled at/dot', 'kareem at gmail dot com'],
    ['parenthesised', 'kareem(at)gmail(dot)com'],
    ['bracketed', 'kareem[at]outlook[dot]com'],
    ['underscored', 'kareem_at_gmail_dot_com'],
    ['no TLD, known provider', 'mail me kareem@gmail'],
    ['provider domain alone', 'reach me on gmail.com'],
    ['multi-label TLD', 'my e-mail: kareem.eladl@yahoo.co.uk'],
    ['Arabic lead-in', 'ايميلي kareem@gmail.com'],
  ]
  for (const [label, text] of cases) {
    test(label, () => assert.ok(containsEmail(text), `should block: ${text}`))
  }
})

describe('social handles — blocked', () => {
  const cases = [
    ['bare @handle', 'add me on insta @kareem_eladl'],
    ['platform + identifier', 'my ig is kareem.eladl99'],
    ['colon form', 'insta: kareemx'],
    ['equals form', 'telegram = kareem_x'],
    ['snapchat', 'my snapchat is kareem.eladl'],
    ['tiktok', 'tiktok kareem_eladl99'],
    ['Arabic platform', 'حسابي انستا kareem_eladl'],
    ['invite, no handle', 'dm me on instagram'],
    ['group link, no handle', 'my whatsapp group link'],
  ]
  for (const [label, text] of cases) {
    test(label, () => assert.ok(containsSocialHandle(text), `should block: ${text}`))
  }
})

describe('external links — blocked', () => {
  const cases = [
    ['telegram short link', 'reach me at t.me/kareem'],
    ['uppercase scheme', 'HTTPS://T.ME/KAREEM'],
    ['shortener', 'bit.ly/abc123'],
    ['spelled dot', 'go to bit(dot)ly/xyz'],
    ['bare domain', 'my site is kareemvillas.com/booking'],
    ['www form', 'www.myvilla.net'],
    ['instagram profile', 'instagram.com/kareem_eladl'],
    ['whatsapp invite', 'chat.whatsapp.com/ABC123'],
    ['linktree', 'linktr.ee/kareem'],
  ]
  for (const [label, text] of cases) {
    test(label, () => assert.ok(containsExternalUrl(text), `should block: ${text}`))
  }
})

describe('ordinary chat — allowed', () => {
  const cases = [
    'see you at 2pm',
    '2 guests, room 401',
    'it costs 3500 EGP for 2 nights',
    "I'll arrive at 5, checkout at 11",
    'the villa sleeps 6 and has 2 pools',
    'great, booking ref 4521 confirmed',
    'we are 2 adults and 1 child arriving on the 12th',
    'The place is on the 5th floor, building 12, gate 3',
    'Total is 15000 EGP for 5 nights, 3000 per night',
    'meet at the gate please',
    'I will be available all day',
    'Available all summer, unavailable in Ramadan',
    'call me old fashioned but I prefer a quiet street',
    'my number of guests is 4, is that ok?',
    'It sleeps 6 comfortably, possibly 8 with the sofa bed',
    'etc. we can talk about it later',
    'arrive at 5 p.m. thanks',
    'Could you please confirm availability for 10-15 September?',
    'الشقة فيها 3 غرف نوم و 2 حمام وتسع 8 اشخاص',
    'الاجمالي 15000 جنيه لمدة 5 ليالي',
    'احنا عائلة من 4 افراد هنوصل يوم 20',
    'الشقة في الدور الخامس عمارة 12',
    // Number-dense profile bios. These are the cost of reducing a whole field to
    // its digits: every number in the text ends up adjacent to the next one, so
    // the shape being matched has to stay narrow enough not to find a phone in
    // an honest listing.
    'Host since 2018. 3 properties, 45 reviews, 4.9 average rating.',
    'Sleeps 10, 1 bedroom, 5 min to the beach, 3 pools, 2 floors, 8 km from town',
    'Built 2003, 12 rooms, 3 pools, 45 guests, 6 baths, 2 kitchens',
    'Check-in 2pm, checkout 11am. 3 nights minimum, 15% off for 7+ nights.',
    'مضيف منذ 2018، 3 شقق، 45 تقييم، 5 نجوم',
  ]
  for (const text of cases) {
    test(JSON.stringify(text).slice(0, 56), () => {
      const v = inspectContent(text, 'chat')
      assert.equal(v.blocked, false, `false positive (${v.kind}) on: ${text}`)
    })
  }
})

describe('allowed links', () => {
  // A map pin and QuickIn's own pages have to keep working — the guard is about
  // leaving the platform, not about links as such.
  const cases = [
    'the location pin: https://maps.app.goo.gl/xY12ab',
    'see the listing on https://quickin.app/explore/abc',
    'https://www.google.com/maps/place/Cairo',
  ]
  for (const text of cases) {
    test(JSON.stringify(text).slice(0, 56), () => assert.equal(blocked(text), false))
  }
})

describe('classification', () => {
  test('a phone number reports as phone', () => assert.equal(kindOf('01012345678'), 'phone'))
  test('an address reports as email', () => assert.equal(kindOf('kareem@gmail.com'), 'email'))
  test('a handle reports as social', () => assert.equal(kindOf('my snapchat is kareem_x'), 'social'))
  test('a link reports as url', () => assert.equal(kindOf('bit.ly/abc'), 'url'))
  test('clean text reports nothing', () => assert.equal(kindOf('see you at 2pm'), null))
})

describe('surfaces', () => {
  test('every surface blocks the same number', () => {
    for (const surface of ['chat', 'review', 'listing', 'profile']) {
      assert.ok(blocked('call me on 01012345678', surface), `${surface} should block`)
    }
  })

  test('the wording names the surface', () => {
    assert.match(inspectContent('01012345678', 'chat').message, /in chat/)
    assert.match(inspectContent('01012345678', 'review').message, /in reviews/)
    assert.match(inspectContent('01012345678', 'listing').message, /in a listing/)
    assert.match(inspectContent('01012345678', 'profile').message, /in your profile/)
  })

  test('the wording names what was found', () => {
    assert.match(inspectContent('01012345678', 'chat').message, /phone numbers/)
    assert.match(inspectContent('kareem@gmail.com', 'chat').message, /email addresses/)
  })
})

describe('assertNoContactInfo', () => {
  test('throws a typed, user-facing error', () => {
    let caught
    try {
      assertNoContactInfo('call me 01012345678', 'chat')
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'should have thrown')
    assert.ok(isContactBlockedError(caught), 'should be recognisable to a route')
    assert.equal(caught.kind, 'phone')
    // The route shows err.message verbatim, so it has to read as an explanation.
    assert.match(caught.message, /isn’t allowed/)
  })

  test('stays quiet on clean text', () => {
    assert.doesNotThrow(() => assertNoContactInfo('see you at 2pm', 'chat'))
  })

  test('an unrelated error is not mistaken for a block', () => {
    assert.equal(isContactBlockedError(new Error('Conversation not found')), false)
  })
})

describe('split across messages', () => {
  const cases = [
    ['bare fragments', ['010', '1234567'], '8'],
    ['spaced fragments', ['0 1 0', '1 2 3'], '4 5 6 7 8'],
    ['sentence + intent', ['you can reach me at 0100'], '1234567 anytime'],
    ['address then TLD', ['my email is kareem@gmail'], '.com'],
    ['name then address', ['kareem'], '@gmail.com'],
    ['platform then handle', ['find me on insta'], 'kareem_eladl'],
  ]
  for (const [label, prev, next] of cases) {
    test(`blocks: ${label}`, () => assert.ok(combinesIntoContact(prev, next).blocked))
  }

  const benign = [
    ['rooms and baths', ['the villa sleeps 6'], 'and has 2 bathrooms'],
    ['pricing chatter', ['it costs 3500 for the week'], 'so 500 per night roughly'],
    ['dates + guests', ['arriving on the 12th'], 'leaving on the 15th, 3 of us'],
    ['contact word, few digits', ['call me later about breakfast'], 'we are 2 adults 1 child'],
    ['sentence ending in a digit', ['arrive at 5.'], 'come by later'],
    ['plain pleasantries', ['see you soon'], 'thanks'],
  ]
  for (const [label, prev, next] of benign) {
    test(`allows: ${label}`, () => {
      const v = combinesIntoContact(prev, next)
      assert.equal(v.blocked, false, `false positive (${v.kind}) on: ${prev} + ${next}`)
    })
  }
})

describe('edge cases', () => {
  test('empty and blank text is clean', () => {
    for (const t of ['', '   ', null, undefined]) assert.equal(inspectContent(t, 'chat').blocked, false)
  })
  test('a long clean message is clean', () => {
    assert.equal(blocked('hello '.repeat(300)), false)
  })
})
