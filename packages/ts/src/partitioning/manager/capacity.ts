import type { PartitionIndex } from '../../core/partition'
import { ErrorCodes, NarsilError } from '../../errors'
import type { IndexConfig } from '../../types/schema'
import type { PartitionManager } from './types'

export type CapacityScope = 'index' | 'partition'

export interface CapacitySource {
  indexName: string
  config: IndexConfig
  partitionCount(): number
  documentCount(): number
  getPartition(partitionId: number): PartitionIndex
}

export type CapacityChecks = Pick<PartitionManager, 'assertCapacity' | 'assertPartitionCapacity'>

export function createCapacityChecks(source: CapacitySource): CapacityChecks {
  const { indexName, config } = source

  return {
    assertCapacity(pendingWrites = 0, partitionCountCap?: number): void {
      const maxDocsPerPartition = config.partitions?.maxDocsPerPartition
      if (maxDocsPerPartition === undefined) return
      const partitionCount = source.partitionCount()
      const effectivePartitionCount =
        partitionCountCap === undefined ? partitionCount : Math.min(partitionCount, partitionCountCap)
      const totalCapacity = maxDocsPerPartition * effectivePartitionCount
      const currentCount = source.documentCount() + pendingWrites
      if (currentCount < totalCapacity) return
      throw new NarsilError(
        ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
        `Index "${indexName}" has reached its capacity of ${totalCapacity} documents (${maxDocsPerPartition} per partition × ${effectivePartitionCount} partitions)`,
        {
          indexName,
          currentCount,
          totalCapacity,
          maxDocsPerPartition,
          partitionCount: effectivePartitionCount,
        },
      )
    },

    assertPartitionCapacity(partitionId: number, pendingWrites = 0): void {
      const maxDocsPerPartition = config.partitions?.maxDocsPerPartition
      if (maxDocsPerPartition === undefined) return
      const currentCount = source.getPartition(partitionId).count() + pendingWrites
      if (currentCount < maxDocsPerPartition) return
      throw new NarsilError(
        ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
        `Partition ${partitionId} of index "${indexName}" has reached its capacity of ${maxDocsPerPartition} documents`,
        { indexName, partitionId, currentCount, maxDocsPerPartition },
      )
    },
  }
}
