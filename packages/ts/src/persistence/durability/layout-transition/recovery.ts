import { createPartitionRouter, rewriteSpillOf } from '#platform/storage-host'
import { createRebalancer } from '../../../partitioning/rebalancer'
import type { IndexMetadata } from '../../../types/internal'
import type { DurableDirectory } from '../durable-filesystem'
import { checkpointLastSeqNo, checkpointPrimaryTerm, type PartitionCheckpoint } from '../partition-checkpoint'
import { type ReplayDeps, replayWal, replayWalUpTo } from '../recovery'
import { readSegmentManifest } from '../segment/load'
import type { CheckpointStore } from '../segment/store'
import { SINGLE_NODE_PRIMARY_TERM } from '../seq-owner'
import { readWalSegments } from '../wal-segments'
import { invalidTransition, type LayoutTransition, readTransition } from './codec'

export interface StoredLayout {
  transition: LayoutTransition | null
  changedMetadata: boolean
  replaysOldLayout: boolean
}

export async function settleStoredLayout(store: CheckpointStore, metadata: IndexMetadata): Promise<StoredLayout> {
  const transition = await readTransition(store, metadata.indexName)
  const decoded = await readSegmentManifest(store, metadata.indexName)
  const partitionCount = decoded?.kind === 'current' ? decoded.manifest.checkpoint.length : metadata.partitionCount
  if (
    transition !== null &&
    partitionCount !== transition.oldPartitionCount &&
    partitionCount !== transition.newPartitionCount
  ) {
    invalidTransition('matches neither the manifest nor the metadata')
  }
  if (transition !== null && decoded === null && partitionCount !== transition.oldPartitionCount) {
    invalidTransition('has no old checkpoint or matching metadata')
  }
  const changedMetadata = partitionCount !== metadata.partitionCount
  metadata.partitionCount = partitionCount
  return {
    transition,
    changedMetadata,
    replaysOldLayout: transition !== null && partitionCount === transition.oldPartitionCount,
  }
}

async function checkRetiredHead(
  directory: DurableDirectory,
  indexName: string,
  head: PartitionCheckpoint,
): Promise<void> {
  const wal = await readWalSegments(directory, indexName, head.partitionId)
  if (wal === null) return
  if (
    wal.highestReadFromWal > head.lastSeqNo ||
    wal.marker.state.highestDurableSeqNo > head.lastSeqNo ||
    wal.activeTail?.entries.some(entry => entry.seqNo > head.lastSeqNo)
  ) {
    invalidTransition('has records above a retired partition head')
  }
}

export async function replayAcrossLayout(
  directory: DurableDirectory,
  indexName: string,
  transition: LayoutTransition,
  checkpoint: PartitionCheckpoint[],
  deps: ReplayDeps,
): Promise<{ checkpoint: PartitionCheckpoint[]; removeUnread: () => Promise<void> }> {
  const terms: number[] = []
  for (const head of transition.oldHeads) {
    const from = checkpointLastSeqNo(checkpoint, head.partitionId)
    if (from > head.lastSeqNo) invalidTransition('has an old head below its checkpoint')
    const replayed = await replayWalUpTo(directory, indexName, head.partitionId, from, head.lastSeqNo, deps)
    if (replayed.highestSeqNo < head.lastSeqNo) invalidTransition('is missing an admitted old record')
    terms[head.partitionId] = Math.max(
      head.primaryTerm,
      replayed.highestPrimaryTerm,
      checkpointPrimaryTerm(checkpoint, head.partitionId),
    )
    if (head.partitionId >= transition.newPartitionCount) await checkRetiredHead(directory, indexName, head)
  }
  const spill = await rewriteSpillOf({ directory, writeRecords: deps.writeRecords ?? null }, deps.manager)
  await createRebalancer().rebalance(
    deps.manager,
    transition.newPartitionCount,
    createPartitionRouter(),
    undefined,
    spill,
  )
  const replayed: PartitionCheckpoint[] = []
  for (let partitionId = 0; partitionId < transition.newPartitionCount; partitionId++) {
    const head = transition.oldHeads[partitionId]
    const next = await replayWal(directory, indexName, partitionId, head?.lastSeqNo ?? 0, deps)
    replayed.push({
      partitionId,
      lastSeqNo: next.highestSeqNo,
      primaryTerm: Math.max(terms[partitionId] ?? SINGLE_NODE_PRIMARY_TERM, next.highestPrimaryTerm),
    })
  }
  return { checkpoint: replayed, removeUnread: async () => spill?.removeUnread(deps.manager) }
}
