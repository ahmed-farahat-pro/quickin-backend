// Unit tests for src/lib/local/listing-image-core.ts — where a listing photo's
// bytes live, and how a stored `listing_images.url` is classified.
//
// Offline: no database, no network, no Blob store. Run with `npm test`.
// The explicit `.ts` extension is required — Node strips types but its ESM
// resolver needs the extension, and listing-image-core.ts has no relative
// imports, which is what makes it loadable here. See the backend README → Testing.
//
// The point of the module is that a row's url may be EITHER an inline data URL
// (everything written before the Blob migration, and anything written by a
// deployment with no BLOB_READ_WRITE_TOKEN) or an https URL, so the tests below
// pin both shapes. A reader that assumed the migration had happened would blank
// every photo on a listing the backfill had not reached yet.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  base64ByteLength,
  isHostedImageUrl,
  isImageDataUrl,
  listingImageBlobPath,
  parseImageDataUrl,
} from '../../src/lib/local/listing-image-core.ts'

/** The opening bytes of a real JPEG, as a host's browser would send them. */
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const BLOB_URL = 'https://abc123.public.blob.vercel-storage.com/listings/xyz/photo-Ab3.jpg'
const LISTING_ID = '9a6c812f-f753-4715-9511-f22b253b96c7'

describe('base64ByteLength', () => {
  test('counts decoded bytes without decoding, padding included', () => {
    // "TWFu" → "Man" (3 bytes, no padding); "TWE=" → "Ma"; "TQ==" → "M".
    assert.equal(base64ByteLength('TWFu'), 3)
    assert.equal(base64ByteLength('TWE='), 2)
    assert.equal(base64ByteLength('TQ=='), 1)
  })

  test('ignores whitespace and treats missing input as zero', () => {
    assert.equal(base64ByteLength(' TW Fu\n'), 3)
    for (const v of [null, undefined, '', 0]) assert.equal(base64ByteLength(v), 0)
  })

  test('agrees with an actual decode', () => {
    const payload = JPEG.split(',')[1]
    assert.equal(base64ByteLength(payload), Buffer.from(payload, 'base64').byteLength)
  })
})

describe('parseImageDataUrl', () => {
  test('pulls apart a data URL into mime, payload, extension and size', () => {
    const parsed = parseImageDataUrl(JPEG)
    assert.equal(parsed.mime, 'image/jpeg')
    assert.equal(parsed.base64, '/9j/4AAQSkZJRg==')
    // jpeg → jpg: the mime subtype and the file extension are not the same word.
    assert.equal(parsed.ext, 'jpg')
    assert.equal(parsed.byteLength, Buffer.from(parsed.base64, 'base64').byteLength)
  })

  test('tolerates the spacing and casing a data URL may legally carry', () => {
    assert.equal(parseImageDataUrl('  DATA:IMAGE/PNG ; BASE64 , iVBORw0KGgo= ').mime, 'image/png')
  })

  test('maps the formats a phone camera produces', () => {
    assert.equal(parseImageDataUrl(PNG).ext, 'png')
    assert.equal(parseImageDataUrl('data:image/webp;base64,UklGRg==').ext, 'webp')
    assert.equal(parseImageDataUrl('data:image/heic;base64,AAAAFGZ0eXA=').ext, 'heic')
    // An image type we have no extension for still uploads — the blob's
    // contentType is what a browser honours, so refusing it would help nobody.
    assert.equal(parseImageDataUrl('data:image/tiff;base64,SUkqAA==').ext, 'bin')
  })

  test('returns null for anything that is not an inline image', () => {
    for (const v of [null, undefined, '', BLOB_URL, 'data:application/pdf;base64,JVBERi0=', 7]) {
      assert.equal(parseImageDataUrl(v), null)
    }
  })

  test('returns null for a data URL with no payload', () => {
    // An empty photo would otherwise upload a zero-byte blob and blank the card.
    assert.equal(parseImageDataUrl('data:image/jpeg;base64,'), null)
    assert.equal(parseImageDataUrl('data:image/jpeg;base64,   '), null)
  })
})

describe('isImageDataUrl / isHostedImageUrl', () => {
  test('the two shapes a stored url may take are told apart', () => {
    assert.equal(isImageDataUrl(JPEG), true)
    assert.equal(isHostedImageUrl(JPEG), false)

    assert.equal(isHostedImageUrl(BLOB_URL), true)
    assert.equal(isImageDataUrl(BLOB_URL), false)
  })

  test('neither claims a value that is not a photo source at all', () => {
    for (const v of [null, undefined, '', 'photo.jpg', 'ftp://host/a.jpg']) {
      assert.equal(isImageDataUrl(v), false)
      assert.equal(isHostedImageUrl(v), false)
    }
  })
})

describe('listingImageBlobPath', () => {
  test('groups a listing photo under its listing id', () => {
    assert.equal(listingImageBlobPath(LISTING_ID, 'jpg'), `listings/${LISTING_ID}/photo.jpg`)
  })

  test('refuses to interpolate an extension that is not one', () => {
    // The extension is derived from attacker-supplied mime text, so a path
    // separator or a query string in it must not reach the blob key.
    for (const bad of ['../../etc', 'jpg?x=1', 'j/pg', '', 'toolongext']) {
      assert.equal(listingImageBlobPath(LISTING_ID, bad), `listings/${LISTING_ID}/photo.bin`)
    }
  })
})
