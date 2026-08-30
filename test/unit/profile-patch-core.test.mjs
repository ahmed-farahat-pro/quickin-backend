// Unit tests for src/lib/local/profile-patch-core.ts — how PATCH /api/local/profile
// tells "you didn't mention this field" apart from "you emptied it".
//
// The rule these lock down is the fix for a bug that was live on every client:
// updateProfile wrote each column with COALESCE($n, col), so an explicit null —
// which is exactly what iOS and Android send for a removed photo or an emptied
// bio — was read as "leave it alone". Removing your profile photo did nothing.
//
// Offline: no database, no network, no server. Run with `npm test`.
// Note the explicit `.ts` extension — Node 22 strips types, but its ESM resolver
// needs the extension. profile-patch-core.ts has no imports, which is what makes
// it loadable here at all. See README → Testing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIELD_SPELLINGS,
  MAX_AVATAR_URL_CHARS,
  isClearedValue,
  readProfileField,
  readProfilePatch,
} from '../../src/lib/local/profile-patch-core.ts'

describe('absent vs cleared — the distinction the SQL used to lose', () => {
  test('a field the body never mentions is absent, not cleared', () => {
    // The avatar case is the one that mattered: both apps save the avatar through
    // this endpoint, and a name-only save must not wipe the photo.
    assert.deepEqual(readProfileField({ full_name: 'Layla' }, 'avatar_url'), { kind: 'absent' })
    assert.deepEqual(readProfileField({}, 'bio'), { kind: 'absent' })
  })

  test('an explicit null is cleared — what iOS sends for a removed photo', () => {
    assert.deepEqual(readProfileField({ avatar_url: null }, 'avatar_url'), { kind: 'cleared' })
    assert.deepEqual(readProfileField({ bio: null }, 'bio'), { kind: 'cleared' })
    assert.deepEqual(readProfileField({ age: null }, 'age'), { kind: 'cleared' })
  })

  test('an empty string is cleared — what Android and the web form send', () => {
    assert.deepEqual(readProfileField({ bio: '' }, 'bio'), { kind: 'cleared' })
    assert.deepEqual(readProfileField({ phone: '' }, 'phone'), { kind: 'cleared' })
    assert.deepEqual(readProfileField({ age: '' }, 'age'), { kind: 'cleared' })
  })

  test('whitespace and invisibles are cleared, not a value', () => {
    // A bio of three spaces is an empty bio; it must reach the column as NULL so
    // one absent bio looks like every other absent bio.
    for (const blank of ['   ', '\t', '\n', '​', '﻿  ']) {
      assert.deepEqual(readProfileField({ bio: blank }, 'bio'), { kind: 'cleared' }, JSON.stringify(blank))
    }
  })

  test('a real value is set, and arrives unchanged for the route to judge', () => {
    assert.deepEqual(readProfileField({ bio: 'Diver.' }, 'bio'), { kind: 'set', value: 'Diver.' })
    // Not trimmed here: normalization belongs to the field's own policy module,
    // so the length a bio is judged on is the length that gets stored.
    assert.deepEqual(readProfileField({ bio: '  hi  ' }, 'bio'), { kind: 'set', value: '  hi  ' })
  })
})

describe('zero and false are values, not blanks', () => {
  test('the number 0 is set', () => {
    // Age 0 is refused later by checkAge's range, but it must reach that check as
    // a submitted value rather than being silently read as "cleared" here.
    assert.deepEqual(readProfileField({ age: 0 }, 'age'), { kind: 'set', value: 0 })
  })

  test('the string "0" is set', () => {
    assert.deepEqual(readProfileField({ age: '0' }, 'age'), { kind: 'set', value: '0' })
  })

  test('isClearedValue agrees', () => {
    assert.equal(isClearedValue(0), false)
    assert.equal(isClearedValue(false), false)
    assert.equal(isClearedValue(null), true)
    assert.equal(isClearedValue(undefined), true)
    assert.equal(isClearedValue(''), true)
  })
})

describe('field spellings in the wild', () => {
  test('older Android builds send fullName', () => {
    assert.deepEqual(readProfileField({ fullName: 'Layla' }, 'full_name'), { kind: 'set', value: 'Layla' })
  })

  test('avatarUrl is read as avatar_url', () => {
    assert.deepEqual(readProfileField({ avatarUrl: 'data:image/jpeg;base64,AA' }, 'avatar_url'), {
      kind: 'set',
      value: 'data:image/jpeg;base64,AA',
    })
  })

  test('the snake_case spelling wins when both are present', () => {
    // Ordering is what makes this deterministic rather than key-order dependent.
    assert.deepEqual(readProfileField({ full_name: 'A', fullName: 'B' }, 'full_name'), { kind: 'set', value: 'A' })
    assert.equal(FIELD_SPELLINGS.full_name[0], 'full_name')
  })

  test('a null under an alias still clears', () => {
    assert.deepEqual(readProfileField({ avatarUrl: null }, 'avatar_url'), { kind: 'cleared' })
  })
})

describe('readProfilePatch — every field classified in one pass', () => {
  test('a body that only removes the photo touches nothing else', () => {
    // This is exactly what the web avatar picker sends when someone hits Remove.
    const patch = readProfilePatch({ avatar_url: null })
    assert.equal(patch.avatar_url.kind, 'cleared')
    for (const field of ['full_name', 'age', 'phone', 'bio', 'country']) {
      assert.equal(patch[field].kind, 'absent', `${field} must be left alone`)
    }
  })

  test('a full mobile save classifies each field on its own', () => {
    // iOS sends every field on every save: name and phone as text, age and avatar
    // as explicit null once cleared.
    const patch = readProfilePatch({
      full_name: 'Layla Hassan',
      age: null,
      phone: '010 1234 5678',
      bio: '',
      avatar_url: null,
    })
    assert.deepEqual(patch.full_name, { kind: 'set', value: 'Layla Hassan' })
    assert.equal(patch.age.kind, 'cleared')
    assert.deepEqual(patch.phone, { kind: 'set', value: '010 1234 5678' })
    assert.equal(patch.bio.kind, 'cleared')
    assert.equal(patch.avatar_url.kind, 'cleared')
    assert.equal(patch.country.kind, 'absent')
  })

  test('a body that is not an object leaves everything alone', () => {
    // The route reaches here with `{}` when the JSON fails to parse, but a client
    // can also post a bare array or string; none of them may write a column.
    for (const body of [null, undefined, 'nope', 42, ['full_name', 'x']]) {
      const patch = readProfilePatch(body)
      for (const field of Object.keys(FIELD_SPELLINGS)) {
        assert.equal(patch[field].kind, 'absent', `${JSON.stringify(body)} → ${field}`)
      }
    }
  })

  test('an inherited key is not a submission', () => {
    // `in` walks the prototype chain, so a body whose prototype carries `bio`
    // must not count as having submitted one.
    const patch = readProfilePatch(Object.create({ bio: 'inherited' }))
    assert.equal(patch.bio.kind, 'absent')
  })
})

describe('the avatar size cap', () => {
  test('is large enough for a downscaled photo and small enough to bound the row', () => {
    // The pickers produce ~15KB; the cap is ~300KB decoded.
    assert.equal(MAX_AVATAR_URL_CHARS, 400_000)
    assert.ok(MAX_AVATAR_URL_CHARS > 20_000)
  })
})
