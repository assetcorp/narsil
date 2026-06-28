import { ErrorCodes, NarsilError } from '../../../errors'
import type { SerializablePartition } from '../../../types/internal'

export function mergeBucketPartitions(
  parts: SerializablePartition[],
  fallback: { indexName: string; partitionId: number; totalPartitions: number; language: string },
): SerializablePartition {
  const merged: SerializablePartition = {
    indexName: parts[0]?.indexName ?? fallback.indexName,
    partitionId: parts[0]?.partitionId ?? fallback.partitionId,
    totalPartitions: parts[0]?.totalPartitions ?? fallback.totalPartitions,
    language: parts[0]?.language ?? fallback.language,
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

  for (const part of parts) {
    assignSchema(merged, part)
    mergeDocuments(merged, part)
    mergeInvertedIndex(merged, part)
    mergeFieldIndexes(merged, part)
    mergeStatistics(merged, part)
  }

  merged.docCount = merged.statistics.totalDocuments
  recomputeAverages(merged)
  validateMergedPartition(merged)
  return merged
}

function validateMergedPartition(merged: SerializablePartition): void {
  for (const [token, list] of Object.entries(merged.invertedIndex)) {
    const distinctDocIds = new Set<string>()
    for (const posting of list.postings) {
      if (!(posting.docId in merged.documents)) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_LOAD_FAILED,
          `Merged segment posting references document "${posting.docId}" that is absent from the partition`,
          { token, docId: posting.docId },
        )
      }
      distinctDocIds.add(posting.docId)
    }
    if (list.docFrequency !== distinctDocIds.size) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Merged segment token "${token}" has docFrequency ${list.docFrequency} but ${distinctDocIds.size} distinct documents in its postings`,
        { token, docFrequency: list.docFrequency, distinctDocuments: distinctDocIds.size },
      )
    }
  }
}

function assignSchema(merged: SerializablePartition, part: SerializablePartition): void {
  for (const [field, type] of Object.entries(part.schema)) {
    const existing = merged.schema[field]
    if (existing !== undefined && existing !== type) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment schemas disagree on field "${field}": "${existing}" vs "${type}"`,
        { field, existing, found: type },
      )
    }
    merged.schema[field] = type
  }
}

function mergeDocuments(merged: SerializablePartition, part: SerializablePartition): void {
  for (const [docId, doc] of Object.entries(part.documents)) {
    if (docId in merged.documents) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Document "${docId}" appears in more than one segment; buckets must be disjoint`,
        { docId },
      )
    }
    merged.documents[docId] = doc
  }
}

function mergeInvertedIndex(merged: SerializablePartition, part: SerializablePartition): void {
  for (const [token, list] of Object.entries(part.invertedIndex)) {
    const existing = merged.invertedIndex[token]
    if (existing === undefined) {
      merged.invertedIndex[token] = { docFrequency: list.docFrequency, postings: [...list.postings] }
      continue
    }
    existing.docFrequency += list.docFrequency
    for (const posting of list.postings) {
      existing.postings.push(posting)
    }
  }
}

function mergeFieldIndexes(merged: SerializablePartition, part: SerializablePartition): void {
  for (const [path, entries] of Object.entries(part.fieldIndexes.numeric)) {
    let target = merged.fieldIndexes.numeric[path]
    if (target === undefined) {
      target = []
      merged.fieldIndexes.numeric[path] = target
    }
    for (const entry of entries) {
      target.push(entry)
    }
  }

  for (const [path, idx] of Object.entries(part.fieldIndexes.boolean)) {
    let target = merged.fieldIndexes.boolean[path]
    if (target === undefined) {
      target = { trueDocs: [], falseDocs: [] }
      merged.fieldIndexes.boolean[path] = target
    }
    for (const docId of idx.trueDocs) {
      target.trueDocs.push(docId)
    }
    for (const docId of idx.falseDocs) {
      target.falseDocs.push(docId)
    }
  }

  for (const [path, values] of Object.entries(part.fieldIndexes.enum)) {
    let target = merged.fieldIndexes.enum[path]
    if (target === undefined) {
      target = Object.create(null)
      merged.fieldIndexes.enum[path] = target
    }
    for (const [value, docIds] of Object.entries(values)) {
      let bucket = target[value]
      if (bucket === undefined) {
        bucket = []
        target[value] = bucket
      }
      for (const docId of docIds) {
        bucket.push(docId)
      }
    }
  }

  for (const [path, entries] of Object.entries(part.fieldIndexes.geopoint)) {
    let target = merged.fieldIndexes.geopoint[path]
    if (target === undefined) {
      target = []
      merged.fieldIndexes.geopoint[path] = target
    }
    for (const entry of entries) {
      target.push(entry)
    }
  }
}

function mergeStatistics(merged: SerializablePartition, part: SerializablePartition): void {
  merged.statistics.totalDocuments += part.statistics.totalDocuments
  for (const [field, length] of Object.entries(part.statistics.totalFieldLengths)) {
    merged.statistics.totalFieldLengths[field] = (merged.statistics.totalFieldLengths[field] ?? 0) + length
  }
  for (const [token, freq] of Object.entries(part.statistics.docFrequencies)) {
    merged.statistics.docFrequencies[token] = (merged.statistics.docFrequencies[token] ?? 0) + freq
  }
}

function recomputeAverages(merged: SerializablePartition): void {
  const averages: Record<string, number> = Object.create(null)
  const total = merged.statistics.totalDocuments
  for (const [field, length] of Object.entries(merged.statistics.totalFieldLengths)) {
    averages[field] = total > 0 ? length / total : 0
  }
  merged.statistics.averageFieldLengths = averages
  merged.avgDocLength = Object.values(averages).reduce((sum, value) => sum + value, 0)
}
