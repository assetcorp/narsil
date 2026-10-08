import type { PartitionManager } from '../partitioning/manager'
import type { CapacityScope } from '../partitioning/manager/capacity'
import type { NarsilEventMap } from '../types/events'
import type { PartitionConfig } from '../types/schema'

export type InsertedDocuments = string | readonly string[]

export interface WatermarkNotifier {
  check(indexName: string, inserted?: InsertedDocuments): void
  forget(indexName: string): void
}

export interface WatermarkDeps {
  getManager(indexName: string): PartitionManager | undefined
  getPartitionConfig(indexName: string): PartitionConfig | undefined
  emit(payload: NarsilEventMap['partitionWatermark']): void
}

export function createWatermarkNotifier(deps: WatermarkDeps, scope: CapacityScope = 'index'): WatermarkNotifier {
  const latchedCapacity = new Map<string, number>()
  const latchedPartitions = new Map<string, Set<number>>()

  function checkIndex(indexName: string, manager: PartitionManager, maxDocs: number, watermark: number): void {
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

  function checkPartitions(
    indexName: string,
    manager: PartitionManager,
    maxDocs: number,
    watermark: number,
    insertedDocIds: readonly string[],
  ): void {
    const threshold = watermark * maxDocs
    const latched = latchedPartitions.get(indexName) ?? new Set<number>()
    latchedPartitions.set(indexName, latched)
    const checked = new Set<number>()
    for (const docId of insertedDocIds) {
      const partitionId = manager.partitionIdOf(docId) ?? manager.routePartition(docId)
      if (checked.has(partitionId)) continue
      checked.add(partitionId)
      const documentCount = manager.getPartition(partitionId).count()
      if (documentCount < threshold) {
        latched.delete(partitionId)
        continue
      }
      if (latched.has(partitionId)) continue
      latched.add(partitionId)
      deps.emit({ indexName, documentCount, capacity: maxDocs, partitionCount: manager.partitionCount, partitionId })
    }
  }

  function check(indexName: string, inserted?: InsertedDocuments): void {
    const partitionConfig = deps.getPartitionConfig(indexName)
    const maxDocs = partitionConfig?.maxDocsPerPartition
    const watermark = partitionConfig?.watermark
    if (maxDocs === undefined || watermark === undefined) {
      forget(indexName)
      return
    }
    const manager = deps.getManager(indexName)
    if (manager === undefined) {
      forget(indexName)
      return
    }
    if (scope === 'index') {
      checkIndex(indexName, manager, maxDocs, watermark)
      return
    }
    if (inserted !== undefined) {
      checkPartitions(indexName, manager, maxDocs, watermark, typeof inserted === 'string' ? [inserted] : inserted)
    }
  }

  function forget(indexName: string): void {
    latchedCapacity.delete(indexName)
    latchedPartitions.delete(indexName)
  }

  return { check, forget }
}
