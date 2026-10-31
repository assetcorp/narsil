import type { PartitionIndex } from '../../core/partition'
import type { FrozenSegment } from '../../core/partition/frozen'

export function rebuildDocLocations(locations: Map<string, number>, partitions: readonly PartitionIndex[]): void {
  locations.clear()
  for (let i = 0; i < partitions.length; i++) {
    for (const docId of partitions[i].docIds()) {
      locations.set(docId, i)
    }
  }
}

export function recordSegmentDocLocations(
  locations: Map<string, number>,
  partitionId: number,
  segment: FrozenSegment,
): void {
  for (const internalId of segment.docStore.allInternalIds()) {
    const docId = segment.docStore.getExternalId(internalId)
    if (docId !== undefined) locations.set(docId, partitionId)
  }
}

export function rebuildPartitionDocLocations(
  locations: Map<string, number>,
  partitionId: number,
  partition: PartitionIndex,
): void {
  for (const [docId, pid] of locations) {
    if (pid === partitionId) {
      locations.delete(docId)
    }
  }
  for (const docId of partition.docIds()) {
    locations.set(docId, partitionId)
  }
}
