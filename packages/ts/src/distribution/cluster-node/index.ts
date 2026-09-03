import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import { createController } from '../cluster/controller'
import type { ControllerNode } from '../cluster/controller/types'
import { DEFAULT_CONTROLLER_CONFIG } from '../cluster/controller/types'
import { createDataNodeLifecycle } from '../cluster/node-lifecycle'
import type { DataNodeHandle } from '../cluster/node-lifecycle/types'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../cluster/node-lifecycle/types'
import type { NodeRegistration, NodeRole } from '../coordinator/types'
import type { ReplicationLog } from '../replication/types'
import type { TransportMessage } from '../transport/types'
import { cleanupRemovedPartition } from './bootstrap-cleanup'
import {
  clearBootstrapSyncIndex,
  createBootstrapSyncState,
  hasCompletedBootstrapSync,
  runBootstrapSync,
} from './bootstrap-sync'
import { createCatchUpState, startCatchUpPump, stopCatchUpPump } from './catch-up'
import { createClusterNamespace } from './cluster-namespace'
import { createAllocationErrorForwarder, createErrorForwarder } from './error-forwarding'
import { type ClusterLocalEngine, createClusterLocalEngine } from './local-engine'
import { adoptClusterIdentity, orphanedIndexError, reconcileLocalIndexes } from './local-index-reconcile'
import { seedReopenedPrimaryLogs } from './local-replication'
import { createDataNodeHandler } from './message-handler'
import { resolveNodeTargets as resolveTargetsForNode, sendToNode as sendMessageToNode } from './node-messaging'
import { createClusterNodeOperations } from './node-operations'
import { createClusterOperationTracker } from './operation-tracker'
import { type PrimaryPartitionDeps, preparePrimaryPartition } from './primary-partition'
import type { ClusterReadDeps } from './reads'
import {
  replicationLogKey as buildReplicationLogKey,
  deleteIndexReplicationLogs,
  getReplicationLog as readReplicationLog,
  seedReplicationLog as writeSeededReplicationLog,
} from './replication-logs'
import { createSnapshotSyncHandlerState, defaultSnapshotHeaderMetadataProvider } from './snapshot-sync-handler'
import { createMultiplexedControllerTransport, createNotReadyHandler } from './transport-listener'
import type { ClusterNode, ClusterNodeConfig } from './types'
import { DEFAULT_CAPACITY } from './types'
import { validateClusterNodeConfig } from './validate-config'
import type { WriteRoutingDeps } from './write-routing'
import { createPartitionWriteQueues } from './write-routing/partition-queue'

const SPEC_VERSION = '1.0'

/**
 * Builds one node of a cluster, ready to join.
 *
 * The node is idle until you call {@link ClusterNode.start}, which registers
 * it, takes on the partitions the controller allocates to it, and starts
 * answering. A node whose roles include `controller` stands for election and
 * runs allocation for the whole cluster while it holds the lease.
 *
 * @param config - The coordinator, the transport, this node's address, and the
 * settings for the engine it runs locally.
 * @returns The node, ready for {@link ClusterNode.start}.
 *
 * @public
 */
export async function createClusterNode(config: ClusterNodeConfig): Promise<ClusterNode> {
  validateClusterNodeConfig(config)

  const nodeId = config.nodeId ?? generateId()
  const roles: ReadonlyArray<NodeRole> = config.roles ?? ['data', 'coordinator', 'controller']
  const capacity = config.capacity ?? DEFAULT_CAPACITY

  const bootstrapSyncState = createBootstrapSyncState()
  const snapshotSyncHandlerState = createSnapshotSyncHandlerState()
  const replicationLogs = new Map<string, ReplicationLog>()
  let localEngine: ClusterLocalEngine | null = null
  const engine = await createClusterLocalEngine(config.engine, {
    async onIndexOpen(indexName) {
      if (localEngine === null) return
      await seedReopenedPrimaryLogs({
        indexName,
        nodeId,
        engine: localEngine,
        coordinator: config.coordinator,
        replicationLogs,
        replicationConfig: config.replication,
      })
    },
    onIndexClose: indexName => deleteIndexReplicationLogs(replicationLogs, indexName),
  })
  localEngine = engine

  function replicationLogKey(indexName: string, partitionId: number): string {
    return buildReplicationLogKey(indexName, partitionId)
  }

  function getReplicationLog(indexName: string, partitionId: number): ReplicationLog {
    return readReplicationLog(replicationLogs, indexName, partitionId, config.replication)
  }

  function seedReplicationLog(indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm = 0): void {
    writeSeededReplicationLog(replicationLogs, indexName, partitionId, startSeqNo, lastPrimaryTerm, config.replication)
  }

  async function resolveNodeTargets(targetNodeId: string): Promise<string[]> {
    return resolveTargetsForNode(config, targetNodeId)
  }

  async function _sendToNode(targetNodeId: string, message: TransportMessage): Promise<TransportMessage> {
    return sendMessageToNode(config, targetNodeId, message)
  }

  const forwardOnError = createErrorForwarder(config.onError)
  const forwardAllocationError = createAllocationErrorForwarder(forwardOnError)

  const registration: NodeRegistration = {
    nodeId,
    address: config.address,
    roles: [...roles],
    capacity,
    startedAt: new Date().toISOString(),
    version: SPEC_VERSION,
  }

  const hasDataRole = roles.includes('data')
  const hasControllerRole = roles.includes('controller')
  const controllerTransport = hasDataRole ? createMultiplexedControllerTransport(config.transport, nodeId) : null

  const writeDeps: WriteRoutingDeps = {
    nodeId,
    coordinator: config.coordinator,
    engine,
    transport: config.transport,
    getReplicationLog,
    resetReplicationLog: seedReplicationLog,
    partitionWriteQueues: createPartitionWriteQueues(),
    catchUp: createCatchUpState(),
    resolveNodeTargets,
    waitForActiveReplicas: config.replication?.waitForActiveReplicas,
  }

  const orphanedIndexes = new Set<string>()
  const heldPartitionWrites = new Set<Promise<void>>()

  function trackHeldPartitionWrite(write: Promise<void>): void {
    const settled = write.catch(forwardOnError)
    heldPartitionWrites.add(settled)
    void settled.finally(() => heldPartitionWrites.delete(settled))
  }

  let controller: ControllerNode | null = null
  let unregisterHandler: (() => void) | null = null
  let unregisterNotReadyHandler: (() => void) | null = null
  let serving = false
  let isShutdown = false

  const bootstrapSyncDeps = {
    engine,
    coordinator: config.coordinator,
    transport: config.transport,
    sourceNodeId: nodeId,
    resolveNodeTargets,
    getReplicationLog,
    resetReplicationLog: seedReplicationLog,
    applyReplicationEntry: engine.applyReplicationEntry,
    restoreReplicationPartition: engine.restoreReplicationPartition,
    onError: forwardOnError,
  }

  const primaryPartitionDeps: PrimaryPartitionDeps = {
    engine,
    coordinator: config.coordinator,
    nodeId,
    seedReplicationLog,
    replicationLogPosition: (indexName: string, partitionId: number) =>
      getReplicationLog(indexName, partitionId).newestSeqNo ?? 0,
    onError: forwardOnError,
  }

  async function bootstrapPartition(indexName: string, partitionId: number, primaryNodeId: string): Promise<boolean> {
    const succeeded =
      primaryNodeId === nodeId
        ? await preparePrimaryPartition(indexName, partitionId, primaryPartitionDeps)
        : await runBootstrapSync(bootstrapSyncState, indexName, partitionId, primaryNodeId, bootstrapSyncDeps)
    if (succeeded) {
      await adoptClusterIdentity(engine, config.coordinator, indexName)
      await engine.recordHeldPartition(indexName, partitionId)
    }
    return succeeded
  }

  const lifecycle: DataNodeHandle = createDataNodeLifecycle({
    registration,
    coordinator: config.coordinator,
    transport: config.transport,
    knownIndexNames: [],
    bootstrapRetryBaseMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryBaseMs,
    bootstrapRetryMaxMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryMaxMs,
    bootstrapMaxRetries: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapMaxRetries,
    allocationDebounceMs: DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs,
    nodeHeartbeatIntervalMs: DEFAULT_NODE_LIFECYCLE_CONFIG.nodeHeartbeatIntervalMs,
    onBootstrapPartition: bootstrapPartition,
    onHoldPartition: (indexName: string, partitionId: number) => {
      trackHeldPartitionWrite(engine.recordHeldPartition(indexName, partitionId))
    },
    retainedPartitionIds: (indexName: string) => engine.heldPartitionsOf(indexName) ?? [],
    onRemovePartition: (indexName: string, partitionId: number) => {
      clearBootstrapSyncIndex(bootstrapSyncState, indexName, partitionId)
      replicationLogs.delete(replicationLogKey(indexName, partitionId))
      trackHeldPartitionWrite(engine.forgetHeldPartition(indexName, partitionId))
      void cleanupRemovedPartition(indexName, partitionId, {
        engine,
        coordinator: config.coordinator,
        nodeId,
        onError: forwardOnError,
      })
    },
  })

  if (hasControllerRole) {
    controller = createController({
      nodeId,
      coordinator: config.coordinator,
      transport: controllerTransport?.transport ?? config.transport,
      leaseTtlMs: config.controller?.leaseTtlMs ?? DEFAULT_CONTROLLER_CONFIG.leaseTtlMs,
      standbyRetryMs: config.controller?.standbyRetryMs ?? DEFAULT_CONTROLLER_CONFIG.standbyRetryMs,
      knownIndexNames: [],
      onError: forwardAllocationError,
      onElectionError: forwardOnError,
    })
  }

  function guardShutdown(): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.NODE_NOT_JOINED, `Cluster node '${nodeId}' has been shut down`, { nodeId })
    }
  }

  const operationTracker = createClusterOperationTracker({
    guard: guardShutdown,
    assertIndex(indexName) {
      if (orphanedIndexes.has(indexName)) throw orphanedIndexError(nodeId, indexName)
    },
  })
  const trackOp = operationTracker.track
  const transitionIndex = operationTracker.transition

  const readDeps: ClusterReadDeps = { config, nodeId, engine, resolveNodeTargets }

  const cluster = createClusterNamespace({
    nodeId,
    roles,
    coordinator: config.coordinator,
    lifecycle: () => lifecycle,
    controller: () => controller,
    isShutdown: () => isShutdown,
    isServing: () => serving,
    trackOp,
  })

  const node: ClusterNode = {
    get nodeId(): string {
      return nodeId
    },

    get roles(): ReadonlyArray<NodeRole> {
      return roles
    },

    open: (indexName: string) => trackOp(indexName, () => engine.open(indexName)),
    close: (indexName: string) => transitionIndex(indexName, () => engine.close(indexName)),

    ...createClusterNodeOperations({
      trackOp,
      transitionIndex,
      readDeps,
      writeDeps,
      engine,
      coordinator: config.coordinator,
      forgetIndex: (indexName: string) => {
        deleteIndexReplicationLogs(replicationLogs, indexName)
        if (engine.listIndexes().every(index => index.name !== indexName)) {
          orphanedIndexes.delete(indexName)
        }
      },
    }),

    cluster,

    async start() {
      guardShutdown()

      const dispositions = await reconcileLocalIndexes({
        engine,
        coordinator: config.coordinator,
        nodeId,
        onError: forwardOnError,
      })
      for (const [indexName, disposition] of dispositions) {
        if (disposition === 'orphaned') {
          orphanedIndexes.add(indexName)
        }
      }

      if (hasDataRole) {
        unregisterNotReadyHandler = await config.transport.listen(createNotReadyHandler(nodeId))
      }

      await lifecycle.join()

      if (controller !== null) {
        await controller.start()
      }

      if (hasDataRole) {
        const dataHandler = createDataNodeHandler({
          nodeId,
          engine,
          coordinator: config.coordinator,
          writeDeps,
          snapshotSyncState: snapshotSyncHandlerState,
          resolveHeaderMetadata: resolveSnapshotHeaderMetadata,
          isBootstrapSynced: (indexName: string, partitionId: number) =>
            hasCompletedBootstrapSync(bootstrapSyncState, indexName, partitionId),
        })
        const listener = controllerTransport !== null ? controllerTransport.createHandler(dataHandler) : dataHandler
        unregisterHandler = await config.transport.listen(listener)
        startCatchUpPump(writeDeps.catchUp, writeDeps)
      }
      serving = true
    },

    async shutdown() {
      await stopCatchUpPump(writeDeps.catchUp)
      if (isShutdown) {
        return
      }
      isShutdown = true
      serving = false

      await operationTracker.drain()

      if (unregisterHandler !== null) {
        unregisterHandler()
        unregisterHandler = null
      }
      if (unregisterNotReadyHandler !== null) {
        unregisterNotReadyHandler()
        unregisterNotReadyHandler = null
      }

      await lifecycle.shutdown()

      if (controller !== null) {
        await controller.shutdown()
      }

      await Promise.all([...heldPartitionWrites])

      await engine.shutdown()
    },
  }

  return node

  async function resolveSnapshotHeaderMetadata(indexName: string, partitionId: number | null) {
    const fallback = await defaultSnapshotHeaderMetadataProvider(config.coordinator, indexName)
    if (partitionId === null) {
      return fallback
    }

    const localIndex = engine.listIndexes().find(index => index.name === indexName)
    const release = localIndex !== undefined ? await engine.acquireIndexForReplication(indexName) : null
    try {
      const allocation = await config.coordinator.getAllocation(indexName)
      const assignment = allocation?.assignments.get(partitionId)
      const log = getReplicationLog(indexName, partitionId)

      return {
        partitionId,
        primaryTerm: assignment?.primaryTerm ?? fallback.primaryTerm,
        lastSeqNo: log.newestSeqNo ?? 0,
      }
    } finally {
      release?.()
    }
  }
}

export type {
  ClusterControllerConfig,
  ClusterNamespace,
  ClusterNode,
  ClusterNodeConfig,
  ClusterNodeInfo,
  ClusterQueryConfig,
  CreateIndexOptions,
  NodeReadiness,
} from './types'
export { DEFAULT_CAPACITY, DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from './types'
