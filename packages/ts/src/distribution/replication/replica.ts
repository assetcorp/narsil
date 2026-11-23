import {
  decode,
  ErrorCodes,
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  restoreVectorFields,
  validateDocument,
  validateDocumentStrict,
  validateVectorDimensions,
} from '#platform/storage-host'
import type { PartitionInsertOptions } from '../../core/partition'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import type { PartitionManager } from '../../partitioning/manager'
import type { VectorIndex } from '../../vector/vector-index'
import type { EntryValidation, ReplicationLog, ReplicationLogEntry } from './types'

export function validateReplicationEntry(
  entry: ReplicationLogEntry,
  localPrimaryTerm: number,
  log: ReplicationLog,
): EntryValidation {
  if (!log.verifyChecksum(entry)) {
    return { valid: false, error: ErrorCodes.REPLICATION_ENTRY_CORRUPT }
  }

  if (entry.primaryTerm < localPrimaryTerm) {
    return { valid: false, error: ErrorCodes.REPLICATION_TERM_MISMATCH }
  }

  return { valid: true }
}

const CHECKED_DOCUMENT: PartitionInsertOptions = { validate: false }

function requireReplaceable(
  documentId: string,
  partitionDoc: Record<string, unknown>,
  vectors: Map<string, Float32Array>,
  manager: PartitionManager,
  vecIndexes: Map<string, VectorIndex>,
): void {
  validateVectorDimensions(vectors, vecIndexes)
  const { options } = manager.textAnalysis
  validateDocument(partitionDoc, manager.schema, options?.patternValueLimit)
  if (options?.strict) validateDocumentStrict(partitionDoc, manager.schema)
  for (const [fieldPath, vector] of vectors) vecIndexes.get(fieldPath)?.requireRoomFor(documentId, vector)
}

export function applyIndexEntry(
  entry: ReplicationLogEntry,
  manager: PartitionManager,
  vectorFieldPaths: Set<string>,
  vecIndexes: Map<string, VectorIndex>,
  schedulesGraphBuild = true,
): void {
  if (entry.document === null) {
    return
  }

  const document = decode(entry.document) as Record<string, unknown>
  restoreVectorFields(document, vectorFieldPaths)
  const documentId = entry.documentId
  const { partitionDoc, extractedVectors } = prepareDocumentVectors(document, vectorFieldPaths)
  const replacing = manager.has(documentId)

  if (replacing) {
    requireReplaceable(documentId, partitionDoc, extractedVectors, manager, vecIndexes)
    for (const [fieldPath, vecIndex] of vecIndexes) {
      if (!extractedVectors.has(fieldPath)) vecIndex.remove(documentId)
    }
    manager.remove(documentId)
  }

  manager.insert(documentId, partitionDoc, replacing ? CHECKED_DOCUMENT : undefined)
  try {
    insertDocumentVectors(documentId, extractedVectors, vecIndexes, manager.partitionIdOf(documentId))
  } catch (err) {
    manager.remove(documentId)
    removeDocumentVectors(documentId, vecIndexes)
    throw err
  }

  if (!schedulesGraphBuild) return
  for (const fieldPath of extractedVectors.keys()) {
    const vecIndex = vecIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.scheduleBuild()
    }
  }
}

export function applyDeleteEntry(
  entry: ReplicationLogEntry,
  manager: PartitionManager,
  vecIndexes: Map<string, VectorIndex>,
  removedSpellings?: RemovedSpellings,
): void {
  removeDocumentVectors(entry.documentId, vecIndexes)

  if (!manager.has(entry.documentId)) {
    return
  }

  manager.remove(entry.documentId, removedSpellings)
}
