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
import { createClusterLocalEngine } from './local-engine'
import { adoptClusterIdentity, orphanedIndexError, reconcileLocalIndexes } from './local-index-reconcile'
import { createDataNodeHandler } from './message-handler'
import { resolveNodeTargets as resolveTargetsForNode, sendToNode as sendMessageToNode } from './node-messaging'
import { createClusterNodeOperations } from './node-operations'
import { type PrimaryPartitionDeps, preparePrimaryPartition } from './primary-partition'
import type { ClusterReadDeps } from './reads'
import {
  replicationLogKey as buildReplicationLogKey,
  getReplicationLog as readReplicationLog,
  seedReplicationLog as writeSeededReplicationLog,
} from './replication-logs'
import { createSnapshotSyncHandlerState, defaultSnapshotHeaderMetadataProvider } from './snapshot-sync-handler'
import { createMultiplexedControllerTransport } from './transport-listener'
import type { ClusterNamespace, ClusterNode, ClusterNodeConfig } from './types'
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

  const engine = await createClusterLocalEngine(config.engine)
  const bootstrapSyncState = createBootstrapSyncState()
  const snapshotSyncHandlerState = createSnapshotSyncHandlerState()
  const replicationLogs = new Map<string, ReplicationLog>()

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

  const forwardOnError = (error: unknown): void => {
    if (config.onError === undefined) {
      return
    }
    const wrapped = error instanceof Error ? error : new Error(String(error))
    config.onError(wrapped)
  }

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
  const controllerTransport =
    hasDataRole && hasControllerRole ? createMultiplexedControllerTransport(config.transport) : null

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

  let lifecycle: DataNodeHandle | null = null
  let controller: ControllerNode | null = null
  let unregisterHandler: (() => void) | null = null
  let isShutdown = false
  let activeOps = 0
  let drainResolve: (() => void) | null = null

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

  if (hasDataRole) {
    lifecycle = createDataNodeLifecycle({
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
      onRemovePartition: (indexName: string, partitionId: number) => {
        clearBootstrapSyncIndex(bootstrapSyncState, indexName, partitionId)
        replicationLogs.delete(replicationLogKey(indexName, partitionId))
        trackHeldPartitionWrite(engine.forgetHeldPartition(indexName, partitionId))
        // Fire-and-forget: align engine state with allocation by dropping the
        // local index when no other partitions of the same index remain
        // assigned to this node. Errors are surfaced via forwardOnError.
        void cleanupRemovedPartition(indexName, partitionId, {
          engine,
          coordinator: config.coordinator,
          nodeId,
          onError: forwardOnError,
        })
      },
    })
  }

  if (hasControllerRole) {
    controller = createController({
      nodeId,
      coordinator: config.coordinator,
      transport: controllerTransport?.transport ?? config.transport,
      leaseTtlMs: DEFAULT_CONTROLLER_CONFIG.leaseTtlMs,
      standbyRetryMs: DEFAULT_CONTROLLER_CONFIG.standbyRetryMs,
      knownIndexNames: [],
    })
  }

  function guardShutdown(): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.NODE_NOT_JOINED, `Cluster node '${nodeId}' has been shut down`, { nodeId })
    }
  }

  async function trackOp<T>(indexName: string | null, fn: () => Promise<T>): Promise<T> {
    guardShutdown()
    if (indexName !== null && orphanedIndexes.has(indexName)) {
      throw orphanedIndexError(nodeId, indexName)
    }
    activeOps++
    try {
      return await fn()
    } finally {
      activeOps--
      if (activeOps === 0 && drainResolve !== null) {
        drainResolve()
        drainResolve = null
      }
    }
  }

  const readDeps: ClusterReadDeps = { config, nodeId, engine, resolveNodeTargets }

  const cluster: ClusterNamespace = {
    async getAllocation(indexName: string) {
      return trackOp(null, () => config.coordinator.getAllocation(indexName))
    },
    getNodeInfo() {
      const status = lifecycle !== null ? lifecycle.status : isShutdown ? 'shutdown' : 'stopped'
      return { nodeId, roles: [...roles], status }
    },
    isControllerActive() {
      if (controller === null) {
        return false
      }
      return controller.isActive
    },
  }

  const node: ClusterNode = {
    get nodeId(): string {
      return nodeId
    },

    get roles(): ReadonlyArray<NodeRole> {
      return roles
    },

    ...createClusterNodeOperations({
      trackOp,
      readDeps,
      writeDeps,
      engine,
      coordinator: config.coordinator,
      forgetIndex: (indexName: string) => {
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

      if (lifecycle !== null) {
        await lifecycle.join()
      }

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
    },

    async shutdown() {
      await stopCatchUpPump(writeDeps.catchUp)
      if (isShutdown) {
        return
      }
      isShutdown = true

      if (activeOps > 0) {
        await new Promise<void>(resolve => {
          drainResolve = resolve
        })
      }

      if (unregisterHandler !== null) {
        unregisterHandler()
        unregisterHandler = null
      }

      if (lifecycle !== null) {
        await lifecycle.shutdown()
      }

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

    const allocation = await config.coordinator.getAllocation(indexName)
    const assignment = allocation?.assignments.get(partitionId)
    const log = getReplicationLog(indexName, partitionId)

    return {
      partitionId,
      primaryTerm: assignment?.primaryTerm ?? fallback.primaryTerm,
      lastSeqNo: log.newestSeqNo ?? 0,
    }
  }
}

export type {
  ClusterNamespace,
  ClusterNode,
  ClusterNodeConfig,
  ClusterNodeInfo,
  ClusterQueryConfig,
  CreateIndexOptions,
} from './types'
export { DEFAULT_CAPACITY, DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from './types'
