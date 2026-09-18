import { isCompositePartition } from '../../core/partition/composite'
import type { FrozenSegment } from '../../core/partition/frozen'
import { createSharedFrozenSegment, freezeSegmentShared } from '../../core/partition/frozen'
import type { PartitionManager } from '../../partitioning/manager'
import { createRequestId } from '../../workers/protocol'
import { LIVE_TAIL_FLUSH_DOCUMENTS, LIVE_TAIL_FREEZE_FLOOR } from './constants'
import { queueForCopies } from './replication'
import type { OrchestratorState } from './types'

export function liveTailCount(manager: PartitionManager, partitionId: number): number {
  if (partitionId >= manager.partitionCount) return 0
  const partition = manager.getPartition(partitionId)
  return isCompositePartition(partition) ? partition.live.count() : partition.count()
}

function freezeIntoSharedSegment(manager: PartitionManager, partitionId: number): FrozenSegment | null {
  return manager.freezeLiveTail(partitionId, (payload, documents) => {
    const snapshot = freezeSegmentShared(payload, documents)
    return snapshot === null ? null : createSharedFrozenSegment(snapshot)
  })
}

export function freezeLiveTailsBeforeCopiesLoad(manager: PartitionManager): void {
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
    try {
      if (liveTailCount(manager, partitionId) >= LIVE_TAIL_FREEZE_FLOOR) freezeIntoSharedSegment(manager, partitionId)
    } catch (err) {
      console.warn(`Freezing the live tail of partition ${partitionId} of "${manager.indexName}" failed:`, err)
    }
  }
}

function freezeTail(state: OrchestratorState, indexName: string, manager: PartitionManager, partitionId: number): void {
  const segment = freezeIntoSharedSegment(manager, partitionId)
  if (segment === null || segment.sharedSnapshot === null) return
  queueForCopies(state, {
    type: 'freezeLiveTail',
    indexName,
    partitionId,
    snapshot: segment.sharedSnapshot,
    requestId: createRequestId(),
  })
}

export function freezeLiveTail(
  state: OrchestratorState,
  indexName: string,
  manager: PartitionManager,
  partitionId: number,
  floor: number,
): void {
  if (!state.scaledOutIndexes.has(indexName)) return
  if (liveTailCount(manager, partitionId) < floor) return
  try {
    freezeTail(state, indexName, manager, partitionId)
  } catch (err) {
    console.warn(`Freezing the live tail of partition ${partitionId} of "${indexName}" failed:`, err)
  }
}

export function flushGrownTails(state: OrchestratorState, indexName: string): void {
  const manager = state.executor.getManager(indexName)
  if (manager === undefined) return
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
    freezeLiveTail(state, indexName, manager, partitionId, LIVE_TAIL_FLUSH_DOCUMENTS)
  }
}
