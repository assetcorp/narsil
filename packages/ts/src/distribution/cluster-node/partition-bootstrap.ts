import type { ClusterCoordinator } from '../coordinator/types'
import type { ReplicationLog } from '../replication/types'
import type { NodeTransport } from '../transport/types'
import { type BootstrapSyncDeps, type BootstrapSyncState, runBootstrapSync } from './bootstrap-sync'
import type { ClusterLocalEngine } from './local-engine'
import { adoptClusterIdentity, dropSupersededCopy } from './local-index-reconcile'
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
  onError: (error: unknown) => void
  snapshotSpoolDirectory: string
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
    applyReplicationEntries: engine.applyReplicationEntries,
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
