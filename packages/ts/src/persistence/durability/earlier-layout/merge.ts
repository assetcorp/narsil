import { ErrorCodes, NarsilError } from '../../../errors'
import type { SerializablePartition } from '../../../types/internal'
import type { EarlierSegmentContents } from './segment'

export interface MergeFallback {
  indexName: string
  partitionId: number
  totalPartitions: number
  language: string
}

export function mergeTimeOrderedSegments(
  ordered: EarlierSegmentContents[],
  fallback: MergeFallback,
): SerializablePartition {
  const winner = resolveWinners(ordered)
  const first = ordered[0]?.partition
  const merged: SerializablePartition = {
    indexName: first?.indexName ?? fallback.indexName,
    partitionId: first?.partitionId ?? fallback.partitionId,
    totalPartitions: first?.totalPartitions ?? fallback.totalPartitions,
    language: first?.language ?? fallback.language,
    schema: {},
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
    statistics: {
      totalDocuments: 0,
      totalFieldLengths: Object.create(null),
      averageFieldLengths: Object.create(null),
      docFrequencies: Object.create(null),
    },
  }

  for (let segIndex = 0; segIndex < ordered.length; segIndex += 1) {
    const part = ordered[segIndex].partition
    addSegmentSchema(merged.schema, part.schema)
    collectDocuments(merged, part, winner, segIndex)
    collectInvertedIndex(merged, part, winner, segIndex)
    collectFieldIndexes(merged, part, winner, segIndex)
    collectSurfaceForms(merged, part)
  }

  recomputeStatistics(merged)
  validateMergedPartition(merged)
  return merged
}

export function countLiveDocuments(ordered: EarlierSegmentContents[]): number {
  return resolveWinners(ordered).size
}

function resolveWinners(ordered: EarlierSegmentContents[]): Map<string, number> {
  const winner = new Map<string, number>()
  for (let segIndex = 0; segIndex < ordered.length; segIndex += 1) {
    const segment = ordered[segIndex]
    for (const docId of segment.tombstones) {
      winner.delete(docId)
    }
    for (const docId of Object.keys(segment.partition.documents)) {
      winner.set(docId, segIndex)
    }
  }
  return winner
}

function owns(winner: Map<string, number>, docId: string, segIndex: number): boolean {
  return winner.get(docId) === segIndex
}

export function addSegmentSchema(agreed: Record<string, string>, schema: Record<string, string>): void {
  for (const [field, type] of Object.entries(schema)) {
    const existing = agreed[field]
    if (existing !== undefined && existing !== type) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment schemas disagree on field "${field}": "${existing}" vs "${type}"`,
        { field, existing, found: type },
      )
    }
    agreed[field] = type
  }
}

function collectDocuments(
  merged: SerializablePartition,
  part: SerializablePartition,
  winner: Map<string, number>,
  segIndex: number,
): void {
  for (const [docId, doc] of Object.entries(part.documents)) {
    if (owns(winner, docId, segIndex)) {
      merged.documents[docId] = doc
    }
  }
}

function collectInvertedIndex(
  merged: SerializablePartition,
  part: SerializablePartition,
  winner: Map<string, number>,
  segIndex: number,
): void {
  for (const [token, list] of Object.entries(part.invertedIndex)) {
    let target = merged.invertedIndex[token]
    for (const posting of list.postings) {
      if (!owns(winner, posting.docId, segIndex)) continue
      if (target === undefined) {
        target = { docFrequency: 0, postings: [] }
        merged.invertedIndex[token] = target
      }
      target.postings.push(posting)
    }
  }
}

function collectEntries<Entry extends { docId: string }>(
  target: Record<string, Entry[]>,
  source: Record<string, Entry[]>,
  winner: Map<string, number>,
  segIndex: number,
): void {
  for (const [path, entries] of Object.entries(source)) {
    for (const entry of entries) {
      if (!owns(winner, entry.docId, segIndex)) continue
      let bucket = target[path]
      if (bucket === undefined) {
        bucket = []
        target[path] = bucket
      }
      bucket.push(entry)
    }
  }
}

function collectFieldIndexes(
  merged: SerializablePartition,
  part: SerializablePartition,
  winner: Map<string, number>,
  segIndex: number,
): void {
  collectEntries(merged.fieldIndexes.numeric, part.fieldIndexes.numeric, winner, segIndex)
  collectEntries(merged.fieldIndexes.geopoint, part.fieldIndexes.geopoint, winner, segIndex)

  for (const [path, idx] of Object.entries(part.fieldIndexes.boolean)) {
    for (const [docIds, flag] of [
      [idx.trueDocs, true],
      [idx.falseDocs, false],
    ] as const) {
      for (const docId of docIds) {
        if (!owns(winner, docId, segIndex)) continue
        let target = merged.fieldIndexes.boolean[path]
        if (target === undefined) {
          target = { trueDocs: [], falseDocs: [] }
          merged.fieldIndexes.boolean[path] = target
        }
        ;(flag ? target.trueDocs : target.falseDocs).push(docId)
      }
    }
  }

  for (const [path, values] of Object.entries(part.fieldIndexes.enum)) {
    for (const [value, docIds] of Object.entries(values)) {
      for (const docId of docIds) {
        if (!owns(winner, docId, segIndex)) continue
        let target = merged.fieldIndexes.enum[path]
        if (target === undefined) {
          target = Object.create(null)
          merged.fieldIndexes.enum[path] = target
        }
        let bucket = target[value]
        if (bucket === undefined) {
          bucket = []
          target[value] = bucket
        }
        bucket.push(docId)
      }
    }
  }
}

function collectSurfaceForms(merged: SerializablePartition, part: SerializablePartition): void {
  if (!part.surfaceForms) return
  let target = merged.surfaceForms
  if (!target) {
    target = Object.create(null) as NonNullable<SerializablePartition['surfaceForms']>
    merged.surfaceForms = target
  }
  for (const [surface, value] of Object.entries(part.surfaceForms)) {
    const count = typeof value === 'number' ? value : value[0]
    const token = typeof value === 'number' ? surface : value[1]
    const existing = target[surface]
    if (existing === undefined) {
      target[surface] = value
      continue
    }
    const existingCount = typeof existing === 'number' ? existing : existing[0]
    const total = existingCount + count
    target[surface] = token === surface ? total : [total, token]
  }
}

function recomputeStatistics(merged: SerializablePartition): void {
  const totalFieldLengths: Record<string, number> = Object.create(null)
  let totalDocuments = 0
  for (const doc of Object.values(merged.documents)) {
    totalDocuments += 1
    for (const [field, length] of Object.entries(doc.fieldLengths)) {
      totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + length
    }
  }

  const docFrequencies: Record<string, number> = Object.create(null)
  for (const [token, list] of Object.entries(merged.invertedIndex)) {
    const distinct = new Set<string>()
    for (const posting of list.postings) distinct.add(posting.docId)
    list.docFrequency = distinct.size
    docFrequencies[token] = distinct.size
  }

  const averageFieldLengths: Record<string, number> = Object.create(null)
  for (const [field, length] of Object.entries(totalFieldLengths)) {
    averageFieldLengths[field] = totalDocuments > 0 ? length / totalDocuments : 0
  }

  merged.statistics.totalDocuments = totalDocuments
  merged.statistics.totalFieldLengths = totalFieldLengths
  merged.statistics.averageFieldLengths = averageFieldLengths
  merged.statistics.docFrequencies = docFrequencies
  merged.docCount = totalDocuments
  merged.avgDocLength = Object.values(averageFieldLengths).reduce((sum, value) => sum + value, 0)
}

function validateMergedPartition(merged: SerializablePartition): void {
  for (const [token, list] of Object.entries(merged.invertedIndex)) {
    for (const posting of list.postings) {
      if (!(posting.docId in merged.documents)) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_LOAD_FAILED,
          `Merged segment posting references document "${posting.docId}" that is absent from the partition`,
          { token, docId: posting.docId },
        )
      }
    }
  }
}
