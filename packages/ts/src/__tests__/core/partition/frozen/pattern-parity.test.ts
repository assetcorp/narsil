import { describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../../core/partition'
import { createCompositePartition } from '../../../../core/partition/composite'
import { applyPartitionFilters } from '../../../../core/partition/filters'
import {
  createFrozenSegment,
  createSharedFrozenSegment,
  type FrozenSegment,
  freezeSegmentShared,
} from '../../../../core/partition/frozen'
import { mergeFrozenSegments } from '../../../../core/partition/frozen/merge'
import { buildSegmentPayload } from '../../../../core/partition/segment-builder'
import { createPatternWorkMeter } from '../../../../core/pattern-index/work-meter'
import type { FieldFilter } from '../../../../types/filters'
import type { AnyDocument } from '../../../../types/schema'
import { PROBE_TEXTS, patternConfig, patternDocuments, referenceIds } from '../../../filters/pattern/fixtures'
import { english } from '../../partition-index/fixtures'

const schema = patternConfig.schema
const FIELDS = ['code', 'title', 'tags'] as const

function probes(): FieldFilter[] {
  const list: FieldFilter[] = []
  for (const text of PROBE_TEXTS) {
    for (const caseFold of [false, true]) {
      list.push({ contains: text, caseFold }, { eq: text, caseFold }, { ne: text, caseFold })
      list.push({ startsWith: text, caseFold }, { endsWith: text, caseFold })
    }
  }
  list.push({ in: ['ab', 'STRASSE', 'beta'] }, { nin: ['ab', 'beta'], caseFold: true })
  return list
}

function livePartition(documents: AnyDocument[]): PartitionIndex {
  const live = createPartitionIndex(0)
  for (const document of documents) live.insert(String(document.id), document, schema, english)
  return live
}

function sharedSegment(live: PartitionIndex, documents: AnyDocument[]): FrozenSegment {
  const snapshot = freezeSegmentShared(live.encodeSegment(), documents)
  if (snapshot === null) throw new Error('This runtime offers no shared memory')
  return createSharedFrozenSegment(snapshot)
}

function idsOf(read: (filter: FieldFilter, field: string) => Set<string>, field: string, filter: FieldFilter) {
  return [...read(filter, field)].sort()
}

function expectParity(documents: AnyDocument[], read: (filter: FieldFilter, field: string) => Set<string>): void {
  for (const field of FIELDS) {
    for (const filter of probes()) {
      expect(idsOf(read, field, filter), `${field} ${JSON.stringify(filter)}`).toEqual(
        referenceIds(documents, field, filter),
      )
    }
  }
}

function readerOf(segment: Parameters<typeof applyPartitionFilters>[0]) {
  return (filter: FieldFilter, field: string) =>
    applyPartitionFilters(segment, { fields: { [field]: filter } }, schema, createPatternWorkMeter())
}

describe('every form of a segment returns the same documents for a pattern test', () => {
  const documents = patternDocuments()

  it('holds for a growing partition', () => {
    const live = livePartition(documents)
    expectParity(documents, (filter, field) =>
      live.applyFilters({ fields: { [field]: filter } }, schema, createPatternWorkMeter()),
    )
  })

  it('holds for a frozen segment on the heap and in shared memory', () => {
    const live = livePartition(documents)
    expectParity(documents, readerOf(createFrozenSegment(live.encodeSegment(), documents)))
    expectParity(documents, readerOf(sharedSegment(live, documents)))
  })

  it('holds for a segment that the segment builder writes from the documents', () => {
    const payload = buildSegmentPayload(
      documents.map(document => ({ docId: String(document.id), document })),
      schema,
      english,
      undefined,
      true,
    )
    expectParity(documents, readerOf(createFrozenSegment(payload, documents)))
  })

  it('holds for two frozen segments merged into one, with a removed document left out', () => {
    const first = documents.slice(0, 9)
    const second = documents.slice(9)
    const left = sharedSegment(livePartition(first), first)
    const right = sharedSegment(livePartition(second), second)
    left.tombstoneDocument('r03')
    const merged = mergeFrozenSegments([left, right])
    if (merged === null) throw new Error('This runtime offers no shared memory')
    const survivors = documents.filter(document => document.id !== 'r03')
    expectParity(survivors, readerOf(createSharedFrozenSegment(merged)))
  })

  it('holds for a partition that combines frozen segments with a growing tail', () => {
    const composite = createCompositePartition(0)
    const frozenPart = documents.slice(0, 10)
    composite.attachFrozenSegment(sharedSegment(livePartition(frozenPart), frozenPart))
    for (const document of documents.slice(10)) composite.insert(String(document.id), document, schema, english)
    composite.remove('r02', schema, english)
    const replaced = { ...documents[4], code: 'REPLACED-CODE' }
    composite.update('r04', replaced, schema, english)
    const expectedDocuments = documents
      .filter(document => document.id !== 'r02')
      .map(document => (document.id === 'r04' ? replaced : document))
    expectParity(expectedDocuments, (filter, field) =>
      composite.applyFilters({ fields: { [field]: filter } }, schema, createPatternWorkMeter()),
    )
  })

  it('holds once a partition copies its pattern index into another partition', () => {
    const target = createPartitionIndex(0)
    target.mergeSegment(livePartition(documents))
    expectParity(documents, (filter, field) =>
      target.applyFilters({ fields: { [field]: filter } }, schema, createPatternWorkMeter()),
    )

    const fromPayload = createPartitionIndex(0)
    fromPayload.mergeSegmentPayload(livePartition(documents).encodeSegment(), documents)
    expectParity(documents, (filter, field) =>
      fromPayload.applyFilters({ fields: { [field]: filter } }, schema, createPatternWorkMeter()),
    )
  })
})
