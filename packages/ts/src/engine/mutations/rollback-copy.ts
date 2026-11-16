import { isCompositePartition, setNestedValue } from '#platform/optional-writes-host'
import type { RollbackCopy } from '../../core/partition/frozen/document-source'
import type { PartitionManager } from '../../partitioning/manager'

function frozenRollbackCopy(manager: PartitionManager, docId: string): RollbackCopy | undefined {
  const partitionId = manager.partitionIdOf(docId)
  if (partitionId === undefined) return undefined
  const partition = manager.getPartition(partitionId)
  if (!isCompositePartition(partition)) return undefined
  for (const segment of partition.frozenSegments()) {
    const ordinal = segment.docStore.getInternalId(docId)
    if (ordinal !== undefined) return segment.documentSource.copyForRollbackAt?.(ordinal)
  }
  return undefined
}

export function rollbackCopyOf(manager: PartitionManager, docId: string): RollbackCopy | undefined {
  const frozenCopy = frozenRollbackCopy(manager, docId)
  if (frozenCopy === undefined) {
    const document = manager.get(docId)
    return document === undefined ? undefined : () => document
  }
  const vectors: Array<[string, Float32Array]> = []
  for (const [fieldPath, vectorIndex] of manager.getVectorIndexes()) {
    const vector = vectorIndex.getVector(docId)
    if (vector) vectors.push([fieldPath, vector])
  }
  return () => {
    const document = frozenCopy()
    for (const [fieldPath, vector] of vectors) setNestedValue(document as Record<string, unknown>, fieldPath, vector)
    return document
  }
}
