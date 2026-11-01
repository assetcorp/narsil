import type { PartitionIndex, PartitionInsertOptions } from '../../core/partition'
import type { CompositePartition } from '../../core/partition/composite'
import { recordSegmentDocLocations } from './doc-locations'
import { requireNewSegmentDocuments } from './segments'
import type { PartitionManager } from './types'
import { CHECKPOINT_WRITE_LOG, type WriteLogRecorder } from './write-log'

export interface SegmentOperationSource {
  docPartitionMap: Map<string, number>
  writeLogs: WriteLogRecorder
  partitionAt(partitionId: number): PartitionIndex
  validatePartitionId(partitionId: number): void
  asCompositePartition(partitionId: number): CompositePartition
  resolveInsertOptions(): PartitionInsertOptions | undefined
}

export type SegmentOperations = Pick<
  PartitionManager,
  | 'mergeSegment'
  | 'attachFrozenSegment'
  | 'openCheckpointChangeLog'
  | 'diskSegmentAccess'
  | 'swapFrozenSegments'
  | 'freezeLiveTail'
  | 'replaceLiveTail'
>

export function createSegmentOperations(source: SegmentOperationSource): SegmentOperations {
  const { docPartitionMap, writeLogs, validatePartitionId, asCompositePartition, resolveInsertOptions } = source

  return {
    mergeSegment(partitionId, payload, documents) {
      validatePartitionId(partitionId)
      const partition = source.partitionAt(partitionId)
      partition.beginBatch()
      partition.mergeSegmentPayload(payload, documents)
      partition.endBatch()
      for (const docId of payload.docIds) {
        docPartitionMap.set(docId, partitionId)
        writeLogs.documentWritten(docId)
      }
    },

    attachFrozenSegment(partitionId, segment) {
      validatePartitionId(partitionId)
      if (segment.paged === null) requireNewSegmentDocuments(segment, docPartitionMap)
      asCompositePartition(partitionId).attachFrozenSegment(segment)
      if (segment.paged !== null) return
      recordSegmentDocLocations(docPartitionMap, partitionId, segment)
      writeLogs.segmentWritten(segment)
    },

    openCheckpointChangeLog() {
      return writeLogs.open(CHECKPOINT_WRITE_LOG)
    },

    diskSegmentAccess(partitionId) {
      validatePartitionId(partitionId)
      return {
        composite: asCompositePartition(partitionId),
        docPartitionMap,
        insertOptions: resolveInsertOptions(),
      }
    },

    swapFrozenSegments(partitionId, dropSegmentIds, replacement, removedSpellings) {
      validatePartitionId(partitionId)
      const applied = asCompositePartition(partitionId).swapFrozenSegments(
        dropSegmentIds,
        replacement,
        removedSpellings,
      )
      recordSegmentDocLocations(docPartitionMap, partitionId, replacement)
      return applied
    },

    freezeLiveTail(partitionId, freeze) {
      validatePartitionId(partitionId)
      return asCompositePartition(partitionId).freezeLiveTail(freeze)
    },

    replaceLiveTail(partitionId, segment) {
      validatePartitionId(partitionId)
      asCompositePartition(partitionId).replaceLiveTail(segment)
      recordSegmentDocLocations(docPartitionMap, partitionId, segment)
    },
  }
}
