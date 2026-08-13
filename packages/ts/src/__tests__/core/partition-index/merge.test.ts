import { describe, expect, it } from 'vitest'
import type { PartitionIndex } from '../../../core/partition'
import { segmentTransferables } from '../../../core/partition/segment-payload'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { FilterExpression } from '../../../types/filters'
import type { SchemaDefinition } from '../../../types/schema'
import { english, makePartition, simpleSchema } from './fixtures'

const geoSchema: SchemaDefinition = {
  title: 'string',
  tags: 'string[]',
  price: 'number',
  active: 'boolean',
  category: 'enum',
  where: 'geopoint',
}

function documents(count: number): Array<{ id: string; fields: Record<string, unknown> }> {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
  const categories = ['books', 'music', 'film']
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${String(i).padStart(4, '0')}`,
    fields: {
      title: `${words[i % words.length]} ${words[(i + 3) % words.length]} ${words[(i + 5) % words.length]}`,
      tags: [words[(i + 1) % words.length], words[(i + 6) % words.length]],
      price: i % 97,
      active: i % 2 === 0,
      category: categories[i % categories.length],
      where: { lat: (i % 90) - 45, lon: (i % 180) - 90 },
    },
  }))
}

function insertAll(
  partition: PartitionIndex,
  docs: Array<{ id: string; fields: Record<string, unknown> }>,
  schema: SchemaDefinition,
): void {
  partition.beginBatch()
  for (const doc of docs) {
    partition.insert(doc.id, doc.fields, schema, english)
  }
  partition.endBatch()
}

function buildSegments(
  docs: Array<{ id: string; fields: Record<string, unknown> }>,
  slices: number,
  schema: SchemaDefinition,
): PartitionIndex[] {
  const perSlice = Math.ceil(docs.length / slices)
  const segments: PartitionIndex[] = []
  for (let start = 0; start < docs.length; start += perSlice) {
    const segment = makePartition()
    insertAll(segment, docs.slice(start, start + perSlice), schema)
    segments.push(segment)
  }
  return segments
}

function mergeInto(target: PartitionIndex, segments: PartitionIndex[]): void {
  target.beginBatch()
  for (const segment of segments) {
    target.mergeSegment(segment)
  }
  target.endBatch()
}

describe('mergeSegment', () => {
  it('reproduces a sequential insert exactly', () => {
    const docs = documents(400)
    const sequential = makePartition()
    insertAll(sequential, docs, geoSchema)

    const merged = makePartition()
    mergeInto(merged, buildSegments(docs, 4, geoSchema))

    expect(merged.serialize('idx', 1, 'english', geoSchema)).toEqual(
      sequential.serialize('idx', 1, 'english', geoSchema),
    )
  })

  it('gives the same search results and scores as a sequential insert', () => {
    const docs = documents(300)
    const sequential = makePartition()
    insertAll(sequential, docs, simpleSchema)

    const merged = makePartition()
    mergeInto(merged, buildSegments(docs, 5, simpleSchema))

    for (const term of ['alpha', 'beta', 'theta']) {
      const params = { queryTokens: [{ token: term, position: 0 }], fields: ['title'] }
      expect(merged.searchFulltext(params)).toEqual(sequential.searchFulltext(params))
    }
  })

  it('keeps filters working across every field index', () => {
    const docs = documents(200)
    const sequential = makePartition()
    insertAll(sequential, docs, geoSchema)

    const merged = makePartition()
    mergeInto(merged, buildSegments(docs, 3, geoSchema))

    const filters: FilterExpression[] = [
      { fields: { price: { gte: 50 } } },
      { fields: { active: { eq: true } } },
      { fields: { category: { eq: 'music' } } },
    ]
    for (const filter of filters) {
      expect(merged.applyFilters(filter, geoSchema)).toEqual(sequential.applyFilters(filter, geoSchema))
    }
  })

  it('carries document count and statistics over', () => {
    const docs = documents(120)
    const merged = makePartition()
    mergeInto(merged, buildSegments(docs, 4, simpleSchema))

    expect(merged.count()).toBe(120)
    expect(merged.stats.totalDocuments).toBe(120)
    for (const doc of docs) {
      expect(merged.get(doc.id)).toBeDefined()
    }
  })

  it('rejects a document that two segments both hold', () => {
    const docs = documents(10)
    const first = makePartition()
    insertAll(first, docs, simpleSchema)
    const second = makePartition()
    insertAll(second, docs, simpleSchema)

    const merged = makePartition()
    merged.mergeSegment(first)

    expect(() => merged.mergeSegment(second)).toThrow(NarsilError)
    try {
      merged.mergeSegment(second)
    } catch (error) {
      expect((error as NarsilError).code).toBe(ErrorCodes.DOC_ALREADY_EXISTS)
    }
  })

  it('merges an empty segment without changing the target', () => {
    const docs = documents(20)
    const merged = makePartition()
    insertAll(merged, docs, simpleSchema)
    const before = merged.serialize('idx', 1, 'english', simpleSchema)

    merged.mergeSegment(makePartition())

    expect(merged.serialize('idx', 1, 'english', simpleSchema)).toEqual(before)
  })

  it('leaves documents removable and re-addable after a merge', () => {
    const docs = documents(60)
    const merged = makePartition()
    mergeInto(merged, buildSegments(docs, 3, simpleSchema))

    merged.remove('doc-0007', simpleSchema, english)
    expect(merged.has('doc-0007')).toBe(false)
    expect(merged.count()).toBe(59)

    merged.insert('doc-0007', docs[7].fields, simpleSchema, english)
    expect(merged.count()).toBe(60)
    expect(merged.searchFulltext({ queryTokens: [{ token: 'alpha', position: 0 }] }).totalMatched).toBeGreaterThan(0)
  })
})

describe('segment payload', () => {
  function encodeAndMerge(
    docs: Array<{ id: string; fields: Record<string, unknown> }>,
    slices: number,
    schema: SchemaDefinition,
  ): PartitionIndex {
    const perSlice = Math.ceil(docs.length / slices)
    const target = makePartition()
    target.beginBatch()
    for (let start = 0; start < docs.length; start += perSlice) {
      const chunk = docs.slice(start, start + perSlice)
      const segment = makePartition()
      insertAll(segment, chunk, schema)
      const payload = structuredClone(segment.encodeSegment(), {
        transfer: segmentTransferables(segment.encodeSegment()),
      })
      target.mergeSegmentPayload(
        payload,
        chunk.map(doc => doc.fields),
      )
    }
    target.endBatch()
    return target
  }

  it('survives a transfer and reproduces a sequential insert', () => {
    const docs = documents(400)
    const sequential = makePartition()
    insertAll(sequential, docs, geoSchema)

    const merged = encodeAndMerge(docs, 4, geoSchema)

    expect(merged.serialize('idx', 1, 'english', geoSchema)).toEqual(
      sequential.serialize('idx', 1, 'english', geoSchema),
    )
  })

  it('keeps phrase positions intact through the payload', () => {
    const docs = documents(120)
    const sequential = makePartition()
    insertAll(sequential, docs, simpleSchema)

    const merged = encodeAndMerge(docs, 3, simpleSchema)

    const params = {
      queryTokens: [
        { token: 'alpha', position: 0 },
        { token: 'delta', position: 1 },
      ],
      phrase: true,
    }
    expect(merged.searchFulltext(params)).toEqual(sequential.searchFulltext(params))
  })

  it('rejects a document the target already holds', () => {
    const docs = documents(20)
    const target = makePartition()
    insertAll(target, docs, simpleSchema)

    const segment = makePartition()
    insertAll(segment, docs, simpleSchema)

    expect(() =>
      target.mergeSegmentPayload(
        segment.encodeSegment(),
        docs.map(doc => doc.fields),
      ),
    ).toThrow(NarsilError)
  })
})
