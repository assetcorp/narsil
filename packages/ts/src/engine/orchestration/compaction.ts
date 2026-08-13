import { type CompositePartition, isCompositePartition } from '../../core/partition/composite'
import { buildCompactedSegmentPayload } from '../../core/partition/composite/compaction'
import {
  createFrozenSegment,
  createSharedFrozenSegment,
  type FrozenSegment,
  freezeSegmentShared,
  type SharedSegmentSnapshot,
} from '../../core/partition/frozen'
import type { PartitionManager } from '../../partitioning/manager'
import { createRequestId } from '../../workers/protocol'
import { awaitReplicationIdle, replicateToWorkers } from './replication'
import type { OrchestratorState, SegmentLedgerEntry } from './types'

export const COMPACTION_SEGMENT_TRIGGER = 8

function smallestSegmentIds(entries: ReadonlyArray<SegmentLedgerEntry>): string[] {
  return [...entries]
    .sort((a, b) => a.documentCount - b.documentCount)
    .slice(0, COMPACTION_SEGMENT_TRIGGER)
    .map(entry => entry.segmentId)
}

function mainCompositeOf(manager: PartitionManager, partitionId: number): CompositePartition | null {
  if (partitionId >= manager.partitionCount) return null
  const partition = manager.getPartition(partitionId)
  return isCompositePartition(partition) ? partition : null
}

function candidateSegmentIds(
  state: OrchestratorState,
  indexName: string,
  manager: PartitionManager,
  partitionId: number,
): string[] | null {
  const composite = mainCompositeOf(manager, partitionId)
  if (composite !== null) {
    const sizes = composite.frozenSegmentSizes()
    if (sizes.length >= COMPACTION_SEGMENT_TRIGGER) {
      return smallestSegmentIds(
        sizes.map(size => ({ segmentId: size.segmentId, documentCount: size.liveDocumentCount })),
      )
    }
  }
  const ledger = state.segmentLedger.get(indexName)?.get(partitionId)
  if (ledger !== undefined && ledger.length >= COMPACTION_SEGMENT_TRIGGER) {
    return smallestSegmentIds(ledger)
  }
  return null
}

function mainHoldsAll(composite: CompositePartition | null, segmentIds: readonly string[]): boolean {
  if (composite === null) return false
  const held = new Set(composite.frozenSegmentSizes().map(size => size.segmentId))
  return segmentIds.every(segmentId => held.has(segmentId))
}

async function compactPartitionSegments(
  state: OrchestratorState,
  indexName: string,
  manager: PartitionManager,
  partitionId: number,
  segmentIds: string[],
): Promise<boolean> {
  await awaitReplicationIdle(state, indexName)

  let snapshot: SharedSegmentSnapshot | null = null
  const pool = state.workerPool
  const executors = pool !== null && state.promotedIndexes.has(indexName) ? pool.getAllExecutors() : []
  if (executors.length > 0) {
    try {
      snapshot = await executors[0].execute<SharedSegmentSnapshot | null>({
        type: 'compactSegments',
        indexName,
        partitionId,
        segmentIds: [...segmentIds],
        requestId: createRequestId(),
      })
    } catch (err) {
      console.warn('Worker segment compaction failed, compacting on the main thread:', err)
    }
  }

  const composite = mainCompositeOf(manager, partitionId)
  const holdsAll = mainHoldsAll(composite, segmentIds)

  let replacement: FrozenSegment | null = null
  if (snapshot !== null && holdsAll) {
    replacement = createSharedFrozenSegment(snapshot)
  } else if (snapshot === null && holdsAll && composite !== null) {
    const { payload, documents } = buildCompactedSegmentPayload(composite.frozenSegmentsById(segmentIds))
    snapshot = freezeSegmentShared(payload, documents)
    replacement = snapshot === null ? createFrozenSegment(payload, documents) : createSharedFrozenSegment(snapshot)
  }
  if (snapshot === null && replacement === null) return false

  if (composite !== null && replacement !== null) {
    composite.swapFrozenSegments(segmentIds, replacement)
  }
  if (snapshot !== null) {
    await replicateToWorkers(state, {
      type: 'swapSegments',
      indexName,
      partitionId,
      dropSegmentIds: [...segmentIds],
      snapshot,
      requestId: createRequestId(),
    })
  }
  return true
}

async function compactIndexSegments(state: OrchestratorState, indexName: string): Promise<void> {
  const manager = state.executor.getManager(indexName)
  if (!manager) return

  const partitionIds = new Set<number>()
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) partitionIds.add(partitionId)
  for (const partitionId of state.segmentLedger.get(indexName)?.keys() ?? []) partitionIds.add(partitionId)

  for (const partitionId of partitionIds) {
    let picks = candidateSegmentIds(state, indexName, manager, partitionId)
    while (picks !== null) {
      const compacted = await compactPartitionSegments(state, indexName, manager, partitionId, picks)
      if (!compacted) break
      picks = candidateSegmentIds(state, indexName, manager, partitionId)
    }
  }
}

export function maybeCompactSegments(state: OrchestratorState, indexName: string): void {
  if (state.compactionsInFlight.has(indexName)) return
  const run = compactIndexSegments(state, indexName)
    .catch(err => {
      console.warn('Segment compaction failed:', err)
    })
    .finally(() => {
      state.compactionsInFlight.delete(indexName)
    })
  state.compactionsInFlight.set(indexName, run)
}

export async function awaitCompactions(state: OrchestratorState): Promise<void> {
  while (state.compactionsInFlight.size > 0) {
    await Promise.all([...state.compactionsInFlight.values()])
  }
}
