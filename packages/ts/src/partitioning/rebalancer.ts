import { createPartitionIndex, type PartitionIndex } from '../core/partition'
import { ErrorCodes, NarsilError } from '../errors'
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

const CHUNK_SIZE = 1000

export function createRebalancer(): Rebalancer {
  let rebalancing = false

  async function rebalance(
    manager: PartitionManager,
    newPartitionCount: number,
    router: PartitionRouter,
    onProgress?: (progress: RebalanceProgress) => void,
  ): Promise<void> {
    if (rebalancing) {
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

    rebalancing = true

    try {
      const collectedDocs: Array<{ docId: string; document: Record<string, unknown> }> = []
      const currentPartitions = manager.getAllPartitions()

      for (const partition of currentPartitions) {
        for (const docId of partition.docIds()) {
          const document = partition.get(docId)
          if (document) {
            collectedDocs.push({ docId, document: document as Record<string, unknown> })
          }
        }
      }

      const documentsTotal = collectedDocs.length

      onProgress?.({
        phase: 'scanning',
        documentsProcessed: 0,
        documentsTotal,
      })

      const newPartitions: PartitionIndex[] = []
      for (let i = 0; i < newPartitionCount; i++) {
        newPartitions.push(createPartitionIndex(i))
      }

      let documentsProcessed = 0

      for (let chunkStart = 0; chunkStart < collectedDocs.length; chunkStart += CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, collectedDocs.length)

        for (let i = chunkStart; i < chunkEnd; i++) {
          const { docId, document } = collectedDocs[i]
          const targetPartitionId = router.route(docId, newPartitionCount)
          const targetPartition = newPartitions[targetPartitionId]

          if (targetPartition.has(docId)) {
            continue
          }

          targetPartition.insert(docId, document, manager.schema, manager.language, { validate: false })
          documentsProcessed++
        }

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
      rebalancing = false
    }
  }

  return {
    rebalance,
    isRebalancing(): boolean {
      return rebalancing
    },
  }
}
