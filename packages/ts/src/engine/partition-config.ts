import { ErrorCodes, NarsilError, validatePartitionConfig } from '#platform/optional-writes-host'
import type { PartitionConfig } from '../types/schema'
import type { EngineCore } from './core'

export async function updateEnginePartitionConfig(
  core: EngineCore,
  indexName: string,
  partitionConfig: Partial<PartitionConfig>,
): Promise<void> {
  const entry = core.requireIndex(indexName)
  const manager = core.requireManager(indexName)
  if (core.rebalancingIndexes.has(indexName)) {
    throw new NarsilError(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
      `Index "${indexName}" is currently being rebalanced`,
    )
  }
  validatePartitionConfig(partitionConfig)
  if (partitionConfig.maxPartitions !== undefined && partitionConfig.maxPartitions < manager.partitionCount) {
    throw new NarsilError(
      ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      `maxPartitions (${partitionConfig.maxPartitions}) is less than the current partition count (${manager.partitionCount})`,
      { maxPartitions: partitionConfig.maxPartitions, partitionCount: manager.partitionCount },
    )
  }
  const currentDocCount = manager.countDocuments()
  const newMaxDocs = partitionConfig.maxDocsPerPartition ?? entry.config.partitions?.maxDocsPerPartition
  if (newMaxDocs !== undefined) {
    const newTotalCapacity = newMaxDocs * manager.partitionCount
    if (newTotalCapacity < currentDocCount) {
      throw new NarsilError(
        ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
        `New capacity (${newTotalCapacity}) is less than current document count (${currentDocCount})`,
        { newTotalCapacity, currentDocCount },
      )
    }
  }
  if (!entry.config.partitions) entry.config.partitions = {}
  if (partitionConfig.maxDocsPerPartition !== undefined)
    entry.config.partitions.maxDocsPerPartition = partitionConfig.maxDocsPerPartition
  if (partitionConfig.maxPartitions !== undefined) entry.config.partitions.maxPartitions = partitionConfig.maxPartitions
  if (partitionConfig.watermark !== undefined) entry.config.partitions.watermark = partitionConfig.watermark
  if (core.durability) await core.durability.manager.persistMetadata(indexName)
  core.watermarkNotifier.check(indexName)
}
