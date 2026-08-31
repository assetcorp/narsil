import type { PartitionIndex } from '../core/partition'
import type { PartitionManager } from './manager'

/**
 * Resolves the partitions an operation reads: the named partitions the manager
 * holds, or every partition where the caller names none. A named partition the
 * manager does not hold is skipped, which is how a scoped read reports it as
 * failed coverage.
 */
export function partitionsIn(manager: PartitionManager, partitionIds?: number[]): PartitionIndex[] {
  if (partitionIds === undefined) {
    return manager.getAllPartitions()
  }
  const partitions: PartitionIndex[] = []
  for (const partitionId of partitionIds) {
    const partition = manager.partitionAt(partitionId)
    if (partition !== undefined) {
      partitions.push(partition)
    }
  }
  return partitions
}
