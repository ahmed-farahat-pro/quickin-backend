// Unit tests for src/lib/local/admin-listing-photos-core.ts — the ordered gallery
// behind the /ops listing photo viewer. Offline; run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPhotoUrl, toAdminListingPhotos } from '../../src/lib/local/admin-listing-photos-core.ts'

const BLOB = 'https://abc.public.blob.vercel-storage.com/listings/l1/a.jpg'
const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

describe('classifyPhotoUrl', () => {
  test('https and http URLs are hosted', () => {
    assert.equal(classifyPhotoUrl(BLOB), 'hosted')
    assert.equal(classifyPhotoUrl('http://example.com/x.png'), 'hosted')
  })
  test('base64 image data URLs are inline — both shapes stay legal', () => {
    assert.equal(classifyPhotoUrl(DATA), 'inline')
    assert.equal(classifyPhotoUrl('data:image/png ; base64 ,AAAA'), 'inline')
  })
  test('anything else never reaches an <img>', () => {
    for (const bad of [null, undefined, '', '   ', 42, 'javascript:alert(1)', 'data:text/html;base64,PGI+', '/relative.jpg', 'https://has space.com/x']) {
      assert.equal(classifyPhotoUrl(bad), null, String(bad))
    }
  })
})

describe('toAdminListingPhotos', () => {
  test('sorts by the host order, numbering positions from 0', () => {
    const photos = toAdminListingPhotos([
      { id: 'c', url: 'https://x.test/c.jpg', order: 2 },
      { id: 'a', url: 'https://x.test/a.jpg', order: 0 },
      { id: 'b', url: DATA, order: 1 },
    ])
    assert.deepEqual(photos.map((p) => [p.id, p.position, p.kind]), [
      ['a', 0, 'hosted'],
      ['b', 1, 'inline'],
      ['c', 2, 'hosted'],
    ])
  })

  test('accepts numeric-string orders and puts missing orders last, ties stable', () => {
    const photos = toAdminListingPhotos([
      { id: 'none1', url: 'https://x.test/n1.jpg', order: null },
      { id: 'two', url: 'https://x.test/2.jpg', order: '2' },
      { id: 'none2', url: 'https://x.test/n2.jpg' },
      { id: 'one', url: 'https://x.test/1.jpg', order: '1' },
    ])
    assert.deepEqual(photos.map((p) => p.id), ['one', 'two', 'none1', 'none2'])
  })

  test('drops unusable and duplicate urls, renumbering what is left', () => {
    const photos = toAdminListingPhotos([
      { id: 'a', url: BLOB, order: 0 },
      { id: 'bad', url: 'javascript:alert(1)', order: 1 },
      { id: 'dup', url: `  ${BLOB} `, order: 2 },
      { id: 'b', url: 'https://x.test/b.jpg', order: 3 },
    ])
    assert.deepEqual(photos.map((p) => [p.id, p.position]), [['a', 0], ['b', 1]])
    assert.equal(photos[0].url, BLOB)
  })

  test('no rows, or not an array, is an empty gallery', () => {
    assert.deepEqual(toAdminListingPhotos([]), [])
    assert.deepEqual(toAdminListingPhotos(null), [])
    assert.deepEqual(toAdminListingPhotos(undefined), [])
  })

  test('a row without an id still shows', () => {
    const [p] = toAdminListingPhotos([{ url: BLOB, order: 0 }])
    assert.equal(p.id, null)
    assert.equal(p.url, BLOB)
  })
})
