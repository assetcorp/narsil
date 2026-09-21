import { createCompositePartition, isCompositePartition } from '../../../core/partition/composite'
import { createSharedFrozenSegment } from '../../../core/partition/frozen'
import type { SharedSegmentSnapshot } from '../../../core/partition/frozen/shared-snapshot'
import type { PartitionManager } from '../../../partitioning/manager'
import { deserializePayloadV2 } from '../../../serialization/payload-v2'
import type { IndexConfig } from '../../../types/schema'

export interface CapturedFrozenSegment {
  snapshot: SharedSegmentSnapshot
  tombstonedDocIds: string[]
}

export interface CapturedWholePartition {
  partitionId: number
  totalPartitions: number
  docCount: number
  liveTail: Uint8Array | null
  frozen: CapturedFrozenSegment[]
}

export type CapturablePartitions = Pick<
  PartitionManager,
  'getPartition' | 'indexName' | 'partitionCount' | 'language' | 'schema'
>

export function captureWholePartition(
  manager: CapturablePartitions,
  partitionId: number,
): CapturedWholePartition | null {
  const partition = manager.getPartition(partitionId)
  if (!isCompositePartition(partition) || partition.frozenSegmentCount() === 0) return null

  const segmentIds = partition.frozenSegmentSizes().map(size => size.segmentId)
  const frozen: CapturedFrozenSegment[] = []
  for (const segment of partition.frozenSegmentsById(segmentIds)) {
    if (segment.sharedSnapshot === null) return null
    frozen.push({ snapshot: segment.sharedSnapshot, tombstonedDocIds: segment.tombstonedDocIds() })
  }

  const liveTail =
    partition.live.count() === 0
      ? null
      : partition.live.serializeToBytes(
          manager.indexName,
          manager.partitionCount,
          manager.language.name,
          manager.schema,
        )
  return { partitionId, totalPartitions: manager.partitionCount, docCount: partition.count(), liveTail, frozen }
}

export function serializeCapturedPartition(
  indexName: string,
  config: IndexConfig,
  languageName: string,
  captured: CapturedWholePartition,
): Uint8Array {
  const composite = createCompositePartition(captured.partitionId, config.trackPositions ?? true)
  if (captured.liveTail !== null) {
    composite.live.deserialize(deserializePayloadV2(captured.liveTail), config.schema)
  }
  for (const { snapshot, tombstonedDocIds } of captured.frozen) {
    const segment = createSharedFrozenSegment(snapshot)
    for (const docId of tombstonedDocIds) segment.tombstoneDocument(docId)
    composite.attachFrozenSegment(segment)
  }
  return composite.serializeToBytes(indexName, captured.totalPartitions, languageName, config.schema)
}
