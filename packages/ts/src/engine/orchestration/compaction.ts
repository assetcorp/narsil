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
import { freezeLiveTail, LIVE_TAIL_FREEZE_FLOOR } from './live-tail'
import { awaitReplicationIdle, replicateToWorkers } from './replication'
import type { OrchestratorState, SegmentLedgerEntry } from './types'

export const COMPACTION_SEGMENT_TRIGGER = 8
export const IDLE_MERGE_DELAY_MS = 1_000

export type CompactionPolicy = 'ingest' | 'idle'

function smallestSegmentIds(entries: ReadonlyArray<SegmentLedgerEntry>): string[] {
  return [...entries]
    .sort((a, b) => a.documentCount - b.documentCount)
    .slice(0, COMPACTION_SEGMENT_TRIGGER)
    .map(entry => entry.segmentId)
}

function pickSegmentIds(entries: ReadonlyArray<SegmentLedgerEntry>, policy: CompactionPolicy): string[] | null {
  if (policy === 'idle') {
    return entries.length >= 2 ? entries.map(entry => entry.segmentId) : null
  }
  return entries.length >= COMPACTION_SEGMENT_TRIGGER ? smallestSegmentIds(entries) : null
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
  policy: CompactionPolicy,
): string[] | null {
  const composite = mainCompositeOf(manager, partitionId)
  if (composite !== null) {
    const sizes = composite.frozenSegmentSizes()
    const picks = pickSegmentIds(
      sizes.map(size => ({ segmentId: size.segmentId, documentCount: size.liveDocumentCount })),
      policy,
    )
    if (picks !== null) return picks
  }
  const ledger = state.segmentLedger.get(indexName)?.get(partitionId)
  return ledger === undefined ? null : pickSegmentIds(ledger, policy)
}

function mainHoldsAll(composite: CompositePartition | null, segmentIds: readonly string[]): boolean {
  if (composite === null) return false
  const held = new Set(composite.frozenSegmentSizes().map(size => size.segmentId))
  return segmentIds.every(segmentId => held.has(segmentId))
}

async function compactOnWorker(
  state: OrchestratorState,
  indexName: string,
  partitionId: number,
  segmentIds: readonly string[],
): Promise<SharedSegmentSnapshot | null> {
  const pool = state.workerPool
  if (pool === null || !state.scaledOutIndexes.has(indexName)) return null
  const lease = pool.leaseLeastBusy()
  if (lease === null) return null
  try {
    return await lease.executor.execute<SharedSegmentSnapshot | null>({
      type: 'compactSegments',
      indexName,
      partitionId,
      segmentIds: [...segmentIds],
      requestId: createRequestId(),
    })
  } catch (err) {
    console.warn('Worker segment compaction failed, compacting on the main thread:', err)
    return null
  } finally {
    lease.release()
  }
}

async function compactPartitionSegments(
  state: OrchestratorState,
  indexName: string,
  manager: PartitionManager,
  partitionId: number,
  segmentIds: string[],
  policy: CompactionPolicy,
): Promise<boolean> {
  await awaitReplicationIdle(state, indexName)
  if (policy === 'idle' && !state.scaledOutIndexes.has(indexName)) return false

  let snapshot = await compactOnWorker(state, indexName, partitionId, segmentIds)
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

async function compactIndexSegments(
  state: OrchestratorState,
  indexName: string,
  policy: CompactionPolicy,
): Promise<void> {
  const manager = state.executor.getManager(indexName)
  if (!manager) return

  const partitionIds = new Set<number>()
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) partitionIds.add(partitionId)
  for (const partitionId of state.segmentLedger.get(indexName)?.keys() ?? []) partitionIds.add(partitionId)

  for (const partitionId of partitionIds) {
    if (policy === 'idle') {
      await awaitReplicationIdle(state, indexName)
      freezeLiveTail(state, indexName, manager, partitionId, LIVE_TAIL_FREEZE_FLOOR)
    }
    let picks = candidateSegmentIds(state, indexName, manager, partitionId, policy)
    while (picks !== null) {
      const compacted = await compactPartitionSegments(state, indexName, manager, partitionId, picks, policy)
      if (!compacted) break
      picks = candidateSegmentIds(state, indexName, manager, partitionId, policy)
    }
  }
}

export function maybeCompactSegments(
  state: OrchestratorState,
  indexName: string,
  policy: CompactionPolicy = 'ingest',
): void {
  if (state.compactionsInFlight.has(indexName)) {
    if (policy === 'idle') scheduleIdleMerge(state, indexName)
    return
  }
  const run = compactIndexSegments(state, indexName, policy)
    .catch(err => {
      console.warn('Segment compaction failed:', err)
    })
    .finally(() => {
      state.compactionsInFlight.delete(indexName)
    })
  state.compactionsInFlight.set(indexName, run)
}

export function scheduleIdleMerge(state: OrchestratorState, indexName: string): void {
  cancelIdleMerge(state, indexName)
  const timer = setTimeout(() => {
    state.idleMergeTimers.delete(indexName)
    maybeCompactSegments(state, indexName, 'idle')
  }, IDLE_MERGE_DELAY_MS)
  if (typeof timer.unref === 'function') timer.unref()
  state.idleMergeTimers.set(indexName, timer)
}

export function cancelIdleMerge(state: OrchestratorState, indexName: string): void {
  const timer = state.idleMergeTimers.get(indexName)
  if (timer === undefined) return
  clearTimeout(timer)
  state.idleMergeTimers.delete(indexName)
}

export async function awaitCompactions(state: OrchestratorState): Promise<void> {
  while (state.compactionsInFlight.size > 0) {
    await Promise.all([...state.compactionsInFlight.values()])
  }
}
