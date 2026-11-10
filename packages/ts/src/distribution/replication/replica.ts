import {
  decode,
  ErrorCodes,
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  restoreVectorFields,
} from '#platform/storage-host'
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

  if (manager.has(documentId)) {
    removeDocumentVectors(documentId, vecIndexes)
    manager.remove(documentId)
  }

  const { partitionDoc, extractedVectors } = prepareDocumentVectors(document, vectorFieldPaths)
  manager.insert(documentId, partitionDoc)
  try {
    insertDocumentVectors(documentId, extractedVectors, vecIndexes, manager.partitionIdOf(documentId))
  } catch (err) {
    manager.remove(documentId)
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
