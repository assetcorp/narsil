import type { DocIdMap } from '../../core/doc-id-tables/types'
import type { PartitionIndex, PartitionInsertOptions } from '../../core/partition'
import type { CompositePartition } from '../../core/partition/composite'
import type { FrozenSegment } from '../../core/partition/frozen'
import { recordSegmentDocLocations } from './doc-locations'
import { requireNewSegmentDocuments } from './segments'
import type { StatePins } from './state-pins'
import type { PartitionManager } from './types'
import { CHECKPOINT_WRITE_LOG, type WriteLogRecorder } from './write-log'

export interface SegmentOperationSource {
  docPartitionMap: DocIdMap<number>
  writeLogs: WriteLogRecorder
  pins: StatePins
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

function noteSegmentDocuments(segment: FrozenSegment, pins: StatePins): void {
  for (const internalId of segment.docStore.allInternalIds()) {
    const docId = segment.docStore.getExternalId(internalId)
    if (docId !== undefined) pins.beforeWrite(docId)
  }
}

export function createSegmentOperations(source: SegmentOperationSource): SegmentOperations {
  const { docPartitionMap, writeLogs, pins, validatePartitionId, asCompositePartition, resolveInsertOptions } = source

  return {
    mergeSegment(partitionId, payload, documents) {
      validatePartitionId(partitionId)
      const partition = source.partitionAt(partitionId)
      for (const docId of payload.docIds) pins.beforeWrite(docId)
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
      if (pins.held > 0) noteSegmentDocuments(segment, pins)
      asCompositePartition(partitionId).attachFrozenSegment(segment)
      writeLogs.contentChanged()
      if (segment.paged !== null) return
      recordSegmentDocLocations(docPartitionMap, partitionId, segment)
      writeLogs.segmentWritten(segment)
    },

    openCheckpointChangeLog() {
      return writeLogs.open(CHECKPOINT_WRITE_LOG)
    },

    diskSegmentAccess(partitionId) {
      validatePartitionId(partitionId)
      writeLogs.contentChanged()
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
      writeLogs.contentChanged()
      const replacements = 'segmentId' in replacement ? [replacement] : replacement
      for (const segment of replacements) recordSegmentDocLocations(docPartitionMap, partitionId, segment)
      return applied
    },

    freezeLiveTail(partitionId, freeze) {
      validatePartitionId(partitionId)
      writeLogs.contentChanged()
      return asCompositePartition(partitionId).freezeLiveTail(freeze)
    },

    replaceLiveTail(partitionId, segment) {
      validatePartitionId(partitionId)
      writeLogs.contentChanged()
      asCompositePartition(partitionId).replaceLiveTail(segment)
      recordSegmentDocLocations(docPartitionMap, partitionId, segment)
    },
  }
}
