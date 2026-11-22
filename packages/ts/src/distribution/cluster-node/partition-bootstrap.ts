import type { ClusterCoordinator } from '../coordinator/types'
import type { ReplicationLog, ReplicationLogEntry } from '../replication/types'
import type { NodeTransport } from '../transport/types'
import { type BootstrapSyncDeps, type BootstrapSyncState, runBootstrapSync } from './bootstrap-sync'
import { failedCopyRefusal } from './copy-failure'
import type { ClusterLocalEngine } from './local-engine'
import { adoptClusterIdentity, dropSupersededCopy } from './local-index-reconcile'
import type { AppliedReplicationEntries } from './local-replication'
import { type PrimaryPartitionDeps, preparePrimaryPartition } from './primary-partition'
import type { PartitionWriteQueues } from './write-routing/partition-queue'

export interface PartitionBootstrapDeps {
  nodeId: string
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  transport: NodeTransport
  state: BootstrapSyncState
  resolveNodeTargets: (nodeId: string) => Promise<string[]>
  getReplicationLog: (indexName: string, partitionId: number) => ReplicationLog
  seedReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  partitionWriteQueues: PartitionWriteQueues
  canListCopy: PrimaryPartitionDeps['canListCopy']
  failMissingCopy: PrimaryPartitionDeps['failMissingCopy']
  copyFailed: (indexName: string, partitionId: number) => boolean
  failCopy: (indexName: string, partitionId: number, error: Error) => void
  onError: (error: unknown) => void
  snapshotSpoolDirectory: string
}

async function applySyncedEntries(
  deps: PartitionBootstrapDeps,
  entries: readonly ReplicationLogEntry[],
): Promise<AppliedReplicationEntries> {
  const first = entries[0]
  if (first !== undefined && deps.copyFailed(first.indexName, first.partitionId)) {
    const error = failedCopyRefusal(first.indexName, first.partitionId, deps.nodeId)
    return { applied: 0, error, entryUnfit: false }
  }
  const outcome = await deps.engine.applyReplicationEntries(entries)
  const unfit = entries[outcome.applied]
  if (outcome.entryUnfit && unfit !== undefined) {
    const error = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error))
    deps.failCopy(unfit.indexName, unfit.partitionId, error)
  }
  return outcome
}

export function createPartitionBootstrap(
  deps: PartitionBootstrapDeps,
): (indexName: string, partitionId: number, primaryNodeId: string) => Promise<boolean> {
  const { engine, coordinator, nodeId } = deps
  const syncDeps: BootstrapSyncDeps = {
    engine,
    coordinator,
    transport: deps.transport,
    sourceNodeId: nodeId,
    resolveNodeTargets: deps.resolveNodeTargets,
    partitionWriteQueues: deps.partitionWriteQueues,
    getReplicationLog: deps.getReplicationLog,
    resetReplicationLog: deps.seedReplicationLog,
    applyReplicationEntries: entries => applySyncedEntries(deps, entries),
    restartLocalLog: engine.restartLocalLog,
    restoreReplicationPartition: engine.restoreReplicationPartition,
    onError: deps.onError,
    snapshotSpoolDirectory: deps.snapshotSpoolDirectory,
  }

  const primaryDeps: PrimaryPartitionDeps = {
    engine,
    coordinator,
    nodeId,
    seedReplicationLog: deps.seedReplicationLog,
    replicationLogPosition: (indexName: string, partitionId: number) =>
      deps.getReplicationLog(indexName, partitionId).newestSeqNo ?? 0,
    canListCopy: deps.canListCopy,
    failMissingCopy: deps.failMissingCopy,
    onError: deps.onError,
  }

  return async (indexName, partitionId, primaryNodeId) => {
    try {
      await dropSupersededCopy(engine, coordinator, indexName)
    } catch (error) {
      deps.onError(error)
      return false
    }
    const succeeded =
      primaryNodeId === nodeId
        ? await preparePrimaryPartition(indexName, partitionId, primaryDeps)
        : await runBootstrapSync(deps.state, indexName, partitionId, primaryNodeId, syncDeps)
    if (succeeded) {
      await adoptClusterIdentity(engine, coordinator, indexName)
      await engine.recordHeldPartition(indexName, partitionId)
    }
    return succeeded
  }
}
