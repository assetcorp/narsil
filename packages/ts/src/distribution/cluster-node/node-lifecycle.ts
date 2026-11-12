import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../cluster/constants'
import { createDataNodeLifecycle } from '../cluster/node-lifecycle'
import type { DataNodeHandle } from '../cluster/node-lifecycle/types'
import type { NodeRegistration } from '../coordinator/types'
import type { ReplicationLog } from '../replication/types'
import { type BootstrapCleanupDeps, cleanupRemovedPartition, releaseTornDownIndex } from './bootstrap-cleanup'
import { clearBootstrapSyncIndex } from './bootstrap-sync'
import type { BootstrapSyncState } from './bootstrap-sync/types'
import type { CopyFailures } from './copy-failure'
import type { ClusterLocalEngine } from './local-engine'
import { replicationLogKey } from './replication-logs'
import { forgetReshardPartition, type ReshardState } from './reshard/state'
import type { ClusterNodeConfig } from './types'
import { startLeadingTerm } from './write-routing/leading-queue'
import type { WriteRoutingDeps } from './write-routing/types'

export interface NodeLifecycleDeps {
  config: ClusterNodeConfig
  registration: NodeRegistration
  currentRegistration: () => NodeRegistration
  engine: ClusterLocalEngine
  writeDeps: WriteRoutingDeps
  reshard: ReshardState
  bootstrapSyncState: BootstrapSyncState
  replicationLogs: Map<string, ReplicationLog>
  copyFailures: CopyFailures
  bootstrapPartition: (indexName: string, partitionId: number, primaryNodeId: string) => Promise<boolean>
  trackHeldPartitionWrite: (write: Promise<void>) => void
  cleanupDeps: Omit<BootstrapCleanupDeps, 'removedIndexUuid'>
}

export function createNodeLifecycle(deps: NodeLifecycleDeps): DataNodeHandle {
  const { engine, cleanupDeps } = deps
  return createDataNodeLifecycle({
    registration: deps.registration,
    currentRegistration: deps.currentRegistration,
    coordinator: deps.config.coordinator,
    transport: deps.config.transport,
    knownIndexNames: [],
    bootstrapRetryBaseMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryBaseMs,
    bootstrapRetryMaxMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryMaxMs,
    bootstrapMaxRetries: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapMaxRetries,
    allocationDebounceMs: DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs,
    nodeHeartbeatIntervalMs: DEFAULT_NODE_LIFECYCLE_CONFIG.nodeHeartbeatIntervalMs,
    onBootstrapPartition: async (indexName, partitionId, primaryNodeId) => {
      const feedClock = deps.writeDeps.replicaFeedClock
      feedClock?.noteFed(indexName, partitionId)
      const synced =
        (await deps.copyFailures.awaitReset(indexName, partitionId)) &&
        (await deps.bootstrapPartition(indexName, partitionId, primaryNodeId))
      if (synced) feedClock?.noteFed(indexName, partitionId)
      return synced
    },
    replicaUnfedForMs: (indexName, partitionId) =>
      deps.writeDeps.replicaFeedClock?.unfedForMs(indexName, partitionId) ?? 0,
    onLeadingTerm: (indexName, partitionId, assignment) =>
      startLeadingTerm(deps.writeDeps, indexName, partitionId, assignment),
    onHoldPartition: (indexName: string, partitionId: number) => {
      deps.trackHeldPartitionWrite(engine.recordHeldPartition(indexName, partitionId))
    },
    retainedPartitionIds: (indexName: string) => engine.heldPartitionsOf(indexName) ?? [],
    onRemovePartition: (indexName: string, partitionId: number) => {
      const removedIndexUuid = engine.indexUuidOf(indexName)
      forgetReshardPartition(deps.reshard, indexName, partitionId)
      deps.writeDeps.replicaFeedClock?.forget(indexName, partitionId)
      clearBootstrapSyncIndex(deps.bootstrapSyncState, indexName, partitionId)
      deps.replicationLogs.delete(replicationLogKey(indexName, partitionId))
      deps.trackHeldPartitionWrite(engine.forgetHeldPartition(indexName, partitionId))
      void cleanupRemovedPartition(indexName, partitionId, { ...cleanupDeps, removedIndexUuid })
    },
    onIndexTornDown: (indexName: string) => {
      const removedIndexUuid = engine.indexUuidOf(indexName)
      void releaseTornDownIndex(indexName, { ...cleanupDeps, removedIndexUuid })
    },
  })
}
