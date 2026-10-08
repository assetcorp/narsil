import { ErrorCodes, NarsilError } from '../../errors'

export type CapacityScope = 'index' | 'partition'

export interface IndexCapacityCheck {
  indexName: string
  maxDocsPerPartition: number
  documentCount: number
  partitionCount: number
  pendingWrites: number
  partitionCountCap: number | undefined
}

export interface PartitionCapacityCheck {
  indexName: string
  maxDocsPerPartition: number
  partitionId: number
  partitionDocumentCount: number
  pendingWrites: number
}

export function assertIndexCapacity(check: IndexCapacityCheck): void {
  const { indexName, maxDocsPerPartition, documentCount, pendingWrites, partitionCountCap } = check
  const effectivePartitionCount =
    partitionCountCap === undefined ? check.partitionCount : Math.min(check.partitionCount, partitionCountCap)
  const totalCapacity = maxDocsPerPartition * effectivePartitionCount
  if (documentCount + pendingWrites < totalCapacity) return
  throw new NarsilError(
    ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
    `Index "${indexName}" has reached its capacity of ${totalCapacity} documents (${maxDocsPerPartition} per partition × ${effectivePartitionCount} partitions)`,
    {
      indexName,
      currentCount: documentCount + pendingWrites,
      totalCapacity,
      maxDocsPerPartition,
      partitionCount: effectivePartitionCount,
    },
  )
}

export function assertPartitionCapacity(check: PartitionCapacityCheck): void {
  const { indexName, maxDocsPerPartition, partitionId, partitionDocumentCount, pendingWrites } = check
  if (partitionDocumentCount + pendingWrites < maxDocsPerPartition) return
  throw new NarsilError(
    ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
    `Partition ${partitionId} of index "${indexName}" has reached its capacity of ${maxDocsPerPartition} documents`,
    {
      indexName,
      partitionId,
      currentCount: partitionDocumentCount + pendingWrites,
      maxDocsPerPartition,
    },
  )
}
