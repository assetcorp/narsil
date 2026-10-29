import { ErrorCodes, NarsilError } from '../../errors'
import type { HeldCheckpointReport } from '../../types/memory'
import type { IndexState, PartitionState } from './manager-state'
import type { IndexDurabilityHooks } from './types'

export interface HeldCheckpoints {
  refuse(indexName: string, indexState: IndexState | undefined): void
  holds(indexName: string, indexState: IndexState): boolean
  report(indexes: ReadonlyMap<string, IndexState>): HeldCheckpointReport[]
}

function failedPartitionIds(indexState: IndexState): number[] {
  const failed: number[] = []
  for (const [partitionId, partition] of indexState.partitions) if (partition.failed !== null) failed.push(partitionId)
  return failed
}

export function createHeldCheckpoints(hooks: IndexDurabilityHooks): HeldCheckpoints {
  const reported = new WeakSet<PartitionState>()

  function heldReport(indexName: string, indexState: IndexState): HeldCheckpointReport | null {
    const partitionIds = failedPartitionIds(indexState)
    if (partitionIds.length === 0 || hooks.getVectorIndexes(indexName).size === 0) return null
    return {
      indexName,
      partitionIds,
      recordsSinceCheckpoint: indexState.mutationsSinceCheckpoint,
      documentBytesSinceCheckpoint: indexState.documentBytesSinceCheckpoint,
    }
  }

  return {
    refuse(indexName, indexState) {
      const partitionIds = indexState === undefined ? [] : failedPartitionIds(indexState)
      if (partitionIds.length === 0) return
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `Index "${indexName}" cannot take a checkpoint that covers every acknowledged write, because partitions ${partitionIds.join(', ')} failed and have not recovered`,
        { indexName, partitionIds },
      )
    },
    holds(indexName, indexState) {
      const held = heldReport(indexName, indexState)
      if (held === null) return false
      const unreported = held.partitionIds.some(partitionId => {
        const partition = indexState.partitions.get(partitionId)
        return partition !== undefined && !reported.has(partition)
      })
      if (unreported) {
        for (const partitionId of held.partitionIds) {
          const partition = indexState.partitions.get(partitionId)
          if (partition !== undefined) reported.add(partition)
        }
        hooks.onCheckpointHeld?.(held)
      }
      return true
    },
    report(indexes) {
      const held: HeldCheckpointReport[] = []
      for (const [indexName, indexState] of indexes) {
        const entry = heldReport(indexName, indexState)
        if (entry !== null) held.push(entry)
      }
      return held
    },
  }
}
