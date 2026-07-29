import type { PartitionManager } from '../partitioning/manager'
import type { PartitionConfig } from '../types/schema'

export interface WatermarkNotifier {
  check(indexName: string): void
  forget(indexName: string): void
}

export interface WatermarkDeps {
  getManager(indexName: string): PartitionManager | undefined
  getPartitionConfig(indexName: string): PartitionConfig | undefined
  emit(payload: { indexName: string; documentCount: number; capacity: number; partitionCount: number }): void
}

export function createWatermarkNotifier(deps: WatermarkDeps): WatermarkNotifier {
  const latchedCapacity = new Map<string, number>()

  function check(indexName: string): void {
    const partitionConfig = deps.getPartitionConfig(indexName)
    const maxDocs = partitionConfig?.maxDocsPerPartition
    const watermark = partitionConfig?.watermark
    if (maxDocs === undefined || watermark === undefined) {
      latchedCapacity.delete(indexName)
      return
    }
    const manager = deps.getManager(indexName)
    if (!manager) {
      latchedCapacity.delete(indexName)
      return
    }
    const partitionCount = manager.partitionCount
    const capacity = maxDocs * partitionCount
    const documentCount = manager.countDocuments()
    const threshold = watermark * capacity

    if (documentCount < threshold) {
      latchedCapacity.delete(indexName)
      return
    }
    if (latchedCapacity.get(indexName) === capacity) return
    latchedCapacity.set(indexName, capacity)
    deps.emit({ indexName, documentCount, capacity, partitionCount })
  }

  function forget(indexName: string): void {
    latchedCapacity.delete(indexName)
  }

  return { check, forget }
}
