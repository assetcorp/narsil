import { createPartitionIndex, type PartitionIndex, type PartitionInsertOptions } from '../core/partition'
import { ErrorCodes, NarsilError } from '../errors'
import { REBALANCE_CHUNK_SIZE } from './constants'
import type { PartitionManager } from './manager'
import type { PartitionRouter } from './router'

export interface RebalanceProgress {
  phase: 'scanning' | 'moving' | 'swapping' | 'complete'
  documentsProcessed: number
  documentsTotal: number
}

export interface Rebalancer {
  rebalance(
    manager: PartitionManager,
    newPartitionCount: number,
    router: PartitionRouter,
    onProgress?: (progress: RebalanceProgress) => void,
  ): Promise<void>
  isRebalancing(): boolean
}

export function createRebalancer(): Rebalancer {
  const activeManagers = new WeakSet<PartitionManager>()
  let activeCount = 0

  async function rebalance(
    manager: PartitionManager,
    newPartitionCount: number,
    router: PartitionRouter,
    onProgress?: (progress: RebalanceProgress) => void,
  ): Promise<void> {
    if (activeManagers.has(manager)) {
      throw new NarsilError(
        ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
        'A rebalance operation is already in progress',
      )
    }

    if (newPartitionCount <= 0) {
      throw new NarsilError(
        ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
        `New partition count must be greater than 0, received ${newPartitionCount}`,
        { newPartitionCount },
      )
    }

    if (newPartitionCount === manager.partitionCount) {
      throw new NarsilError(
        ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
        `New partition count (${newPartitionCount}) is the same as the current count`,
        { newPartitionCount, currentPartitionCount: manager.partitionCount },
      )
    }

    activeManagers.add(manager)
    activeCount++

    try {
      const currentPartitions = manager.getAllPartitions()
      let documentsTotal = 0
      for (const partition of currentPartitions) {
        documentsTotal += partition.count()
      }

      onProgress?.({
        phase: 'scanning',
        documentsProcessed: 0,
        documentsTotal,
      })

      const newPartitions: PartitionIndex[] = []
      for (let i = 0; i < newPartitionCount; i++) {
        newPartitions.push(createPartitionIndex(i, manager.config.trackPositions ?? true))
      }

      let documentsProcessed = 0
      let chunkFill = 0

      const insertOptions: PartitionInsertOptions = {
        validate: false,
        skipClone: true,
        stopWordOverride: manager.analysis.stopWords,
        customTokenizer: manager.analysis.customTokenizer,
        collectSurfaces: manager.config.surfaceForms !== false,
      }

      for (const partition of currentPartitions) {
        const docIds = [...partition.docIds()]
        for (const docId of docIds) {
          const document = partition.getRef(docId)
          if (!document) continue

          const targetPartitionId = router.route(docId, newPartitionCount)
          const targetPartition = newPartitions[targetPartitionId]

          if (!targetPartition.has(docId)) {
            targetPartition.insert(docId, document, manager.schema, manager.language, insertOptions)
            documentsProcessed++
          }

          chunkFill++
          if (chunkFill >= REBALANCE_CHUNK_SIZE) {
            chunkFill = 0
            onProgress?.({
              phase: 'moving',
              documentsProcessed,
              documentsTotal,
            })
            await new Promise(resolve => setTimeout(resolve, 0))
          }
        }
      }

      if (chunkFill > 0) {
        onProgress?.({
          phase: 'moving',
          documentsProcessed,
          documentsTotal,
        })
        await new Promise(resolve => setTimeout(resolve, 0))
      }

      onProgress?.({
        phase: 'swapping',
        documentsProcessed,
        documentsTotal,
      })

      manager.setPartitions(newPartitions)

      onProgress?.({
        phase: 'complete',
        documentsProcessed,
        documentsTotal,
      })
    } finally {
      activeManagers.delete(manager)
      activeCount--
    }
  }

  return {
    rebalance,
    isRebalancing(): boolean {
      return activeCount > 0
    },
  }
}
