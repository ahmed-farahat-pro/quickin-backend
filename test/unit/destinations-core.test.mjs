// Unit tests for src/lib/local/destinations-core.ts — the explore region rail tree.
//
// Offline: no database, no network, no server. Run with `npm test`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  REGION_META,
  findRegion,
  compareSubAreas,
  buildDestinationTree,
  OTHER_AREA_SLUG,
  isOtherArea,
} from '../../src/lib/local/destinations-core.ts'
import { REGION_VALUES, resortSlug } from '../../src/lib/local/resort-core.ts'

const row = (o) => ({
  id: o.slug, slug: o.slug, name: o.name ?? o.slug, name_ar: null, region: o.region ?? 'North Coast',
  km_marker: null, location_note: null, sort_order: 0, count: 0, ...o,
})

describe('REGION_META', () => {
  test('names are exactly REGION_VALUES, in the same (rail) order', () => {
    assert.deepEqual(REGION_META.map((r) => r.name), [...REGION_VALUES])
  })
  test('slugs are what resortSlug() makes of the name, and unique', () => {
    for (const r of REGION_META) assert.equal(r.slug, resortSlug(r.name))
    assert.equal(new Set(REGION_META.map((r) => r.slug)).size, REGION_META.length)
  })
  test('every region has an Arabic name and an icon key', () => {
    for (const r of REGION_META) {
      assert.match(r.name_ar, /\p{Script=Arabic}/u)
      assert.ok(r.icon)
    }
  })
})

describe('findRegion', () => {
  test('matches the stored name or the slug, case-insensitively', () => {
    assert.equal(findRegion('North Coast')?.slug, 'north-coast')
    assert.equal(findRegion('  north coast ')?.slug, 'north-coast')
    assert.equal(findRegion('sharm-el-sheikh')?.name, 'Sharm El Sheikh')
  })
  test('null for unknown, blank and non-strings', () => {
    assert.equal(findRegion('Sahel'), null)
    assert.equal(findRegion(''), null)
    assert.equal(findRegion(null), null)
    assert.equal(findRegion(42), null)
  })
})

describe('compareSubAreas', () => {
  test('sort_order wins over km', () => {
    const a = row({ slug: 'a', sort_order: 0, km_marker: 200 })
    const b = row({ slug: 'b', sort_order: 10, km_marker: 30 })
    assert.ok(compareSubAreas(a, b) < 0)
  })
  test('then km ascending, unmarked last, NUMERIC strings parsed', () => {
    const list = [row({ slug: 'none' }), row({ slug: 'k124', km_marker: '124.0' }), row({ slug: 'k36', km_marker: 36 })]
    assert.deepEqual(list.sort(compareSubAreas).map((r) => r.slug), ['k36', 'k124', 'none'])
  })
  test('then name', () => {
    const list = [row({ slug: 'z', name: 'Zahra' }), row({ slug: 'a', name: 'Amwaj' })]
    assert.deepEqual(list.sort(compareSubAreas).map((r) => r.slug), ['a', 'z'])
  })
})

describe('buildDestinationTree', () => {
  test('always every region in rail order, count 0 when empty', () => {
    const tree = buildDestinationTree(new Map(), [])
    assert.deepEqual(tree.map((r) => r.name), [...REGION_VALUES])
    assert.ok(tree.every((r) => r.count === 0 && r.sub_areas.length === 0))
  })
  test('region count is its own count, not the sum of its chips', () => {
    const tree = buildDestinationTree(new Map([['North Coast', 5]]), [row({ slug: 'marassi', count: 2 })])
    const nc = tree.find((r) => r.slug === 'north-coast')
    assert.equal(nc.count, 5)
    assert.equal(nc.sub_areas[0].count, 2)
  })
  test('groups sub-areas under their region, sorted, and drops unknown regions', () => {
    const tree = buildDestinationTree(new Map(), [
      row({ slug: 'porto-sokhna', region: 'Ain Sokhna' }),
      row({ slug: 'azha', region: 'Ain Sokhna', km_marker: 34 }),
      row({ slug: 'ghost', region: 'Atlantis' }),
    ])
    assert.deepEqual(tree.find((r) => r.name === 'Ain Sokhna').sub_areas.map((s) => s.slug), ['azha', 'porto-sokhna'])
    assert.equal(tree.flatMap((r) => r.sub_areas).length, 2)
  })
  test('normalizes km_marker to a number and keeps the Arabic name', () => {
    const [s] = buildDestinationTree(new Map(), [row({ slug: 'x', km_marker: '97.0', name_ar: 'مراسي' })])[0].sub_areas
    assert.equal(s.km_marker, 97)
    assert.equal(s.name_ar, 'مراسي')
  })
})

describe('Other chip', () => {
  const nc = (tree) => tree.find((r) => r.name === 'North Coast')
  test('appended LAST with its own count, Arabic name and a per-region id', () => {
    const tree = buildDestinationTree(new Map([['North Coast', 9]]),
      [row({ slug: 'marassi', count: 2 }), row({ slug: 'hacienda', count: 1 })],
      new Map([['North Coast', 4]]))
    const chips = nc(tree).sub_areas
    assert.deepEqual(chips.map((s) => s.slug), ['hacienda', 'marassi', OTHER_AREA_SLUG])
    const other = chips.at(-1)
    assert.equal(other.count, 4)
    assert.equal(other.name, 'Other')
    assert.match(other.name_ar, /\p{Script=Arabic}/u)
    assert.equal(other.id, 'other-north-coast')
    assert.equal(nc(tree).count, 9)
  })
  test('omitted when nothing is unassigned', () => {
    const tree = buildDestinationTree(new Map(), [row({ slug: 'marassi' })], new Map([['North Coast', 0]]))
    assert.deepEqual(nc(tree).sub_areas.map((s) => s.slug), ['marassi'])
  })
  test('omitted for a region with no catalog chips — no chip row to put it in', () => {
    const tree = buildDestinationTree(new Map(), [], new Map([['Dahab', 3]]))
    assert.equal(tree.find((r) => r.name === 'Dahab').sub_areas.length, 0)
  })
  test('a catalog row that somehow has the reserved slug never shadows it', () => {
    const tree = buildDestinationTree(new Map(), [row({ slug: 'marassi' }), row({ slug: 'other', count: 7 })], new Map([['North Coast', 1]]))
    const chips = nc(tree).sub_areas
    assert.equal(chips.filter((s) => s.slug === 'other').length, 1)
    assert.equal(chips.at(-1).count, 1)
  })
  test('isOtherArea: case/space-insensitive, strings only', () => {
    assert.ok(isOtherArea('other'))
    assert.ok(isOtherArea(' Other '))
    assert.ok(!isOtherArea('marassi'))
    assert.ok(!isOtherArea(null))
  })
})
