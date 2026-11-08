import {
  createRequestId,
  createSharedFrozenSegment,
  freezeSegmentShared,
  isCompositePartition,
  LIVE_TAIL_FLUSH_DOCUMENTS,
  LIVE_TAIL_FREEZE_FLOOR,
} from '#platform/worker-copies-host'
import type { FrozenSegment } from '../../core/partition/frozen'
import type { PartitionManager } from '../../partitioning/manager'
import { publishToWorkers } from './publication-code'
import type { OrchestratorState } from './types'

export function liveTailCount(manager: PartitionManager, partitionId: number): number {
  if (partitionId >= manager.partitionCount) return 0
  const partition = manager.getPartition(partitionId)
  return isCompositePartition(partition) ? partition.live.count() : partition.count()
}

function freezeIntoSharedSegment(manager: PartitionManager, partitionId: number): FrozenSegment | null {
  return manager.freezeLiveTail(partitionId, (payload, documents) => {
    const snapshot = freezeSegmentShared(payload, documents, undefined, manager.partialWordAnalysis)
    return snapshot === null ? null : createSharedFrozenSegment(snapshot)
  })
}

export async function freezeLiveTailsBeforeCopiesLoad(manager: PartitionManager): Promise<void> {
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
    try {
      await manager.publication.write(() => {
        if (liveTailCount(manager, partitionId) >= LIVE_TAIL_FREEZE_FLOOR) freezeIntoSharedSegment(manager, partitionId)
      })
    } catch (err) {
      console.warn(`Freezing the live tail of partition ${partitionId} of "${manager.indexName}" failed:`, err)
    }
  }
}

function freezeTail(state: OrchestratorState, indexName: string, manager: PartitionManager, partitionId: number): void {
  const segment = freezeIntoSharedSegment(manager, partitionId)
  if (segment === null || segment.sharedSnapshot === null) return
  publishToWorkers(state, {
    type: 'freezeLiveTail',
    indexName,
    partitionId,
    snapshot: segment.sharedSnapshot,
    requestId: createRequestId(),
  })
}

export async function freezeLiveTail(
  state: OrchestratorState,
  indexName: string,
  manager: PartitionManager,
  partitionId: number,
  floor: number,
): Promise<void> {
  if (!state.scaledOutIndexes.has(indexName)) return
  if (liveTailCount(manager, partitionId) < floor) return
  try {
    await manager.publication.write(() => {
      if (state.executor.getManager(indexName) !== manager || liveTailCount(manager, partitionId) < floor) return
      freezeTail(state, indexName, manager, partitionId)
    })
  } catch (err) {
    console.warn(`Freezing the live tail of partition ${partitionId} of "${indexName}" failed:`, err)
  }
}

export async function flushGrownTails(state: OrchestratorState, indexName: string): Promise<void> {
  const manager = state.executor.getManager(indexName)
  if (manager === undefined) return
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
    await freezeLiveTail(state, indexName, manager, partitionId, LIVE_TAIL_FLUSH_DOCUMENTS)
  }
}
