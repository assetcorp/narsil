import type { DocIdMap } from '../../core/doc-id-tables/types'
import type { PartitionIndex } from '../../core/partition'
import { isCompositePartition } from '../../core/partition/composite'
import type { FrozenSegment } from '../../core/partition/frozen'

function documentIdsHeldInMemory(partition: PartitionIndex): IterableIterator<string> {
  return isCompositePartition(partition) ? partition.documentIdsHeldInMemory() : partition.docIds()
}

export function rebuildDocLocations(locations: DocIdMap<number>, partitions: readonly PartitionIndex[]): void {
  locations.clear()
  for (let i = 0; i < partitions.length; i++) {
    for (const docId of documentIdsHeldInMemory(partitions[i])) {
      locations.set(docId, i)
    }
  }
}

export function recordSegmentDocLocations(
  locations: DocIdMap<number>,
  partitionId: number,
  segment: FrozenSegment,
): void {
  if (segment.paged !== null) return
  for (const internalId of segment.docStore.allInternalIds()) {
    const docId = segment.docStore.getExternalId(internalId)
    if (docId !== undefined) locations.set(docId, partitionId)
  }
}

export function rebuildPartitionDocLocations(
  locations: DocIdMap<number>,
  partitionId: number,
  partition: PartitionIndex,
): void {
  for (const [docId, pid] of locations) {
    if (pid === partitionId) {
      locations.delete(docId)
    }
  }
  for (const docId of documentIdsHeldInMemory(partition)) {
    locations.set(docId, partitionId)
  }
}
