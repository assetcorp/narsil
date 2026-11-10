import type { PartitionIndex } from '../../core/partition'
import { isCompositePartition } from '../../core/partition/composite'
import type { PublicationSettlement } from './publication-gate'

export function createRemovalSettlement(partitions: () => readonly PartitionIndex[]): PublicationSettlement {
  return {
    pending(): boolean {
      for (const partition of partitions()) {
        if (!isCompositePartition(partition)) continue
        for (const segment of partition.frozenSegments()) if (segment.pendingRemovals()) return true
      }
      return false
    },
    settle(): void {
      for (const partition of partitions()) {
        if (!isCompositePartition(partition)) continue
        for (const segment of partition.frozenSegments()) segment.settleRemovals()
      }
    },
  }
}
