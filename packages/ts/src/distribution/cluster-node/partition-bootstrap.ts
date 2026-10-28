import type { ClusterCoordinator } from '../coordinator/types'
import type { ReplicationLog } from '../replication/types'
import type { NodeTransport } from '../transport/types'
import { type BootstrapSyncDeps, type BootstrapSyncState, runBootstrapSync } from './bootstrap-sync'
import type { ClusterLocalEngine } from './local-engine'
import { adoptClusterIdentity } from './local-index-reconcile'
import { type PrimaryPartitionDeps, preparePrimaryPartition } from './primary-partition'

export interface PartitionBootstrapDeps {
  nodeId: string
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  transport: NodeTransport
  state: BootstrapSyncState
  resolveNodeTargets: (nodeId: string) => Promise<string[]>
  getReplicationLog: (indexName: string, partitionId: number) => ReplicationLog
  seedReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
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
    getReplicationLog: deps.getReplicationLog,
    resetReplicationLog: deps.seedReplicationLog,
    applyReplicationEntry: engine.applyReplicationEntry,
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
