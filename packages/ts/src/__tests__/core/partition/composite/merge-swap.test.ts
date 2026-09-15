import { describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../../core/partition'
import { createCompositePartition } from '../../../../core/partition/composite'
import { createFrozenSegment, createSharedFrozenSegment } from '../../../../core/partition/frozen'
import { mergeFrozenSegments } from '../../../../core/partition/frozen/merge'
import type { InternalSearchParams } from '../../../../types/internal'
import type { AnyDocument, SchemaDefinition } from '../../../../types/schema'
import { english, simpleSchema } from '../../partition-index/fixtures'

const CATEGORIES = ['fruit', 'metal', 'stone'] as const
const WORDS = ['apple', 'apply', 'appli', 'banana', 'copper', 'quartz']

function frozenPayloadFor(
  documents: AnyDocument[],
  schema: SchemaDefinition = simpleSchema,
): ReturnType<PartitionIndex['encodeSegment']> {
  const scratch = createPartitionIndex(0)
  for (const doc of documents) {
    scratch.insert(String(doc.id), doc, schema, english, { collectSurfaces: true })
  }
  return scratch.encodeSegment()
}

function exactTermParams(tokens: string[]): InternalSearchParams {
  return {
    queryTokens: tokens.map((token, position) => ({ token, position })),
    tolerance: 0,
    prefixLength: 2,
    exact: true,
  }
}

describe('swapping merged frozen segments into a composite partition', () => {
  it('compacts frozen segments into one and carries later removes into the swap', () => {
    const composite = createCompositePartition(0)
    const allDocs: AnyDocument[] = []
    for (let s = 0; s < 8; s++) {
      const chunk = Array.from({ length: 6 }, (_, i) => ({
        id: `seg${s}-doc${i}`,
        title: `${WORDS[(s + i) % WORDS.length]} shared`,
        price: s * 10 + i,
        active: i % 2 === 0,
        category: CATEGORIES[i % CATEGORIES.length],
      }))
      composite.attachFrozenSegment(createFrozenSegment(frozenPayloadFor(chunk), chunk))
      allDocs.push(...chunk)
    }
    expect(composite.frozenSegmentCount()).toBe(8)

    const segmentIds = composite.frozenSegmentSizes().map(size => size.segmentId)
    const segments = composite.frozenSegmentsById(segmentIds)
    const merged = mergeFrozenSegments(segments)
    if (merged === null) throw new Error('this runtime shares no memory')
    expect(merged.documentCount).toBe(allDocs.length)

    composite.remove('seg3-doc1', simpleSchema, english)
    composite.swapFrozenSegments(segmentIds, createSharedFrozenSegment(merged))

    expect(composite.frozenSegmentCount()).toBe(1)
    expect(composite.count()).toBe(allDocs.length - 1)
    expect(composite.has('seg3-doc1')).toBe(false)
    expect(composite.get('seg0-doc0')).toMatchObject({ id: 'seg0-doc0' })
    expect(composite.get('seg7-doc5')).toMatchObject({ id: 'seg7-doc5' })

    const found = composite.searchFulltext(exactTermParams(['shared']))
    expect(found.totalMatched).toBe(allDocs.length - 1)
    expect(found.scored.some(doc => doc.docId === 'seg3-doc1')).toBe(false)
  })

  it('keeps a document live through the swap when its older copy in another merged segment was removed', () => {
    const composite = createCompositePartition(0)
    const doc = (id: string, title: string, price: number): AnyDocument => ({
      id,
      title,
      price,
      active: true,
      category: 'fruit',
    })
    const older = [
      doc('moved', 'apple first', 1),
      doc('stays', 'banana kept', 2),
      doc('removed-later', 'copper gone', 3),
    ]
    const newer = [doc('moved', 'quartz second', 4), doc('fresh', 'apply fresh', 5)]
    const olderSegment = createFrozenSegment(frozenPayloadFor(older), older)
    olderSegment.tombstoneDocument('moved')
    composite.attachFrozenSegment(olderSegment)
    composite.attachFrozenSegment(createFrozenSegment(frozenPayloadFor(newer), newer))

    const segmentIds = composite.frozenSegmentSizes().map(size => size.segmentId)
    const merged = mergeFrozenSegments(composite.frozenSegmentsById(segmentIds))
    if (merged === null) throw new Error('this runtime shares no memory')
    expect(merged.documentCount).toBe(4)

    composite.remove('removed-later', simpleSchema, english)
    composite.swapFrozenSegments(segmentIds, createSharedFrozenSegment(merged))

    expect(composite.count()).toBe(3)
    expect(composite.get('moved')).toMatchObject({ title: 'quartz second' })
    expect(composite.has('stays')).toBe(true)
    expect(composite.has('fresh')).toBe(true)
    expect(composite.has('removed-later')).toBe(false)
  })

  it('answers the same numeric, boolean, and enum filters from the merged segment as one partition does', () => {
    const schema: SchemaDefinition = {
      title: 'string',
      price: 'number',
      active: 'boolean',
      category: 'enum',
      location: 'geopoint',
    }
    const documents: AnyDocument[] = Array.from({ length: 48 }, (_, i) => ({
      id: `doc-${String(i).padStart(2, '0')}`,
      title: `${WORDS[i % WORDS.length]} shared`,
      price: i,
      active: i % 2 === 0,
      category: CATEGORIES[i % CATEGORIES.length],
      location: { lat: 51 + i / 4, lon: -0.5 - i / 4 },
    }))

    const baseline = createPartitionIndex(0)
    for (const doc of documents) baseline.insert(String(doc.id), doc, schema, english)

    const composite = createCompositePartition(0)
    for (let start = 0; start < documents.length; start += 12) {
      const chunk = documents.slice(start, start + 12)
      composite.attachFrozenSegment(createFrozenSegment(frozenPayloadFor(chunk, schema), chunk))
    }
    const segmentIds = composite.frozenSegmentSizes().map(size => size.segmentId)
    const merged = mergeFrozenSegments(composite.frozenSegmentsById(segmentIds))
    if (merged === null) throw new Error('this runtime shares no memory')
    composite.swapFrozenSegments(segmentIds, createSharedFrozenSegment(merged))

    const fields = {
      fields: {
        price: { between: [10, 40] as [number, number] },
        active: { eq: true },
        category: { in: ['fruit', 'stone'] },
      },
    }
    expect(composite.applyFilters(fields, schema)).toEqual(baseline.applyFilters(fields, schema))
    expect(composite.applyFilters(fields, schema).size).toBeGreaterThan(0)

    const nearby = { fields: { location: { radius: { lat: 51, lon: -0.5, distance: 200, unit: 'km' as const } } } }
    expect(composite.applyFilters(nearby, schema)).toEqual(baseline.applyFilters(nearby, schema))
    expect(composite.applyFilters(nearby, schema).size).toBeGreaterThan(0)

    const allIds = new Set([...composite.docIds()])
    expect(composite.computeFacets(allIds, { category: {}, active: {} }, schema)).toEqual(
      baseline.computeFacets(allIds, { category: {}, active: {} }, schema),
    )
  })
})
