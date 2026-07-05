import { describe, expect, it } from 'vitest'
import { type MergeFallback, mergeTimeOrderedSegments } from '../../../persistence/durability/segment/merge'
import type { SegmentContents } from '../../../persistence/durability/segment/segment-file'
import type { SerializablePartition, SerializedSurfaceForms } from '../../../types/internal'

function fallback(): MergeFallback {
  return { indexName: 'docs', partitionId: 0, totalPartitions: 1, language: 'english' }
}

function segmentOf(
  entries: Array<{ docId: string; token: string }>,
  surfaceForms: SerializedSurfaceForms | undefined,
  tombstones: string[] = [],
): SegmentContents {
  const partition: SerializablePartition = {
    indexName: 'docs',
    partitionId: 0,
    totalPartitions: 1,
    language: 'english',
    schema: { body: 'string' },
    docCount: 0,
    avgDocLength: 0,
    documents: Object.create(null),
    invertedIndex: Object.create(null),
    fieldIndexes: {
      numeric: Object.create(null),
      boolean: Object.create(null),
      enum: Object.create(null),
      geopoint: Object.create(null),
    },
    surfaceForms,
    statistics: {
      totalDocuments: 0,
      totalFieldLengths: Object.create(null),
      averageFieldLengths: Object.create(null),
      docFrequencies: Object.create(null),
    },
  }
  for (const { docId, token } of entries) {
    partition.documents[docId] = { fields: { body: token }, fieldLengths: { body: 1 } }
    let list = partition.invertedIndex[token]
    if (list === undefined) {
      list = { docFrequency: 0, postings: [] }
      partition.invertedIndex[token] = list
    }
    list.postings.push({ docId, termFrequency: 1, field: 'body', positions: [0] })
    list.docFrequency = list.postings.length
  }
  return { partition, tombstones }
}

describe('segment merge surface forms', () => {
  it('sums surface counts across segments and keeps the index token', () => {
    const older = segmentOf([{ docId: 'd1', token: 'secur' }], { security: [1, 'secur'], fox: 2 })
    const newer = segmentOf([{ docId: 'd2', token: 'secur' }], { security: [3, 'secur'] })

    const merged = mergeTimeOrderedSegments([older, newer], fallback())
    expect(merged.surfaceForms?.security).toEqual([4, 'secur'])
    expect(merged.surfaceForms?.fox).toBe(2)
  })

  it('produces no surface map when no segment carries one', () => {
    const older = segmentOf([{ docId: 'd1', token: 'fox' }], undefined)
    const newer = segmentOf([{ docId: 'd2', token: 'dog' }], undefined)

    const merged = mergeTimeOrderedSegments([older, newer], fallback())
    expect(merged.surfaceForms).toBeUndefined()
  })

  it('keeps surfaces from segments that have them when others predate the field', () => {
    const legacy = segmentOf([{ docId: 'd1', token: 'fox' }], undefined)
    const current = segmentOf([{ docId: 'd2', token: 'secur' }], { security: [1, 'secur'] })

    const merged = mergeTimeOrderedSegments([legacy, current], fallback())
    expect(merged.surfaceForms).toEqual({ security: [1, 'secur'] })
  })
})
