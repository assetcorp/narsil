import { ErrorCodes, NarsilError } from '../../errors'
import { bindWriteBlockLookup } from '../../narsil/write-blocks'
import { DEFAULT_CONTROLLER_CONFIG, DEFAULT_NODE_LIFECYCLE_CONFIG } from '../cluster/constants'
import { createController } from '../cluster/controller'
import type { ControllerNode } from '../cluster/controller/types'
import { createDataNodeLifecycle } from '../cluster/node-lifecycle'
import type { DataNodeHandle } from '../cluster/node-lifecycle/types'
import { SPEC_VERSION } from '../cluster/version'
import type { NodeRegistration, NodeRole } from '../coordinator/types'
import { openSnapshotSpoolDirectory } from '../replication/snapshot-spool'
import type { ReplicationLog } from '../replication/types'
import { createAllocationView } from './allocation-view'
import { cleanupRemovedPartition } from './bootstrap-cleanup'
import { clearBootstrapSyncIndex, createBootstrapSyncState, hasCompletedBootstrapSync } from './bootstrap-sync'
import { createCatchUpState, startCatchUpPump, stopCatchUpPump } from './catch-up'
import { createClusterNamespace } from './cluster-namespace'
import { createAllocationErrorForwarder, createErrorForwarder } from './error-forwarding'
import { type ClusterLocalEngine, createClusterLocalEngine } from './local-engine'
import { orphanedIndexError, reconcileLocalIndexes } from './local-index-reconcile'
import { seedReopenedPrimaryLogs } from './local-replication'
import { createNodeMemoryReporting } from './memory/node-memory'
import { findWriteBlock } from './memory/write-block'
import { createDataNodeHandler } from './message-handler'
import { resolveNodeId } from './node-identity'
import { resolveNodeTargets as resolveTargetsForNode } from './node-messaging'
import { createClusterNodeOperations } from './node-operations'
import { createClusterOperationTracker } from './operation-tracker'
import { createPartitionBootstrap } from './partition-bootstrap'
import type { ClusterReadDeps } from './reads'
import {
  replicationLogKey as buildReplicationLogKey,
  deleteIndexReplicationLogs,
  getReplicationLog as readReplicationLog,
  seedReplicationLog as writeSeededReplicationLog,
} from './replication-logs'
import { routableAllocation } from './routable-allocation'
import { createSnapshotSyncHandlerState, nodeSnapshotHeaderMetadata } from './snapshot-sync-handler'
import { createMultiplexedControllerTransport, createNotReadyHandler } from './transport-listener'
import type { ClusterNode, ClusterNodeConfig } from './types'
import { DEFAULT_CAPACITY } from './types'
import { validateClusterNodeConfig } from './validate-config'
import type { WriteRoutingDeps } from './write-routing'
import { createPrimaryNumbering } from './write-routing/numbering'
import { createPartitionWriteQueues } from './write-routing/partition-queue'

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
  const snapshotSpool = await openSnapshotSpoolDirectory(config.engine?.durability?.directory).catch(async err => {
    await engine.shutdown()
    throw err
  })
  const nodeId = await resolveNodeId(config.nodeId, config.engine?.durability?.directory).catch(async err => {
    await engine.shutdown()
    throw err
  })

  function getReplicationLog(indexName: string, partitionId: number): ReplicationLog {
    return readReplicationLog(replicationLogs, indexName, partitionId, config.replication, engine.persistedPositionOf)
  }

  function seedReplicationLog(indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm = 0): void {
    writeSeededReplicationLog(replicationLogs, indexName, partitionId, startSeqNo, lastPrimaryTerm, config.replication)
  }

  const allocationView = createAllocationView(config.coordinator)
  const routingConfig: ClusterNodeConfig = { ...config, coordinator: allocationView.routing }

  async function resolveNodeTargets(targetNodeId: string): Promise<string[]> {
    return resolveTargetsForNode(routingConfig, targetNodeId)
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

  const memoryReporting = createNodeMemoryReporting({
    registration,
    engine,
    coordinator: config.coordinator,
    config: config.memory,
    onFullChange: () => lifecycle.renewRegistration(),
  })

  const hasDataRole = roles.includes('data')
  const hasControllerRole = roles.includes('controller')
  const controllerTransport = hasDataRole ? createMultiplexedControllerTransport(config.transport, nodeId) : null

  const numbering = createPrimaryNumbering()
  engine.numberEntriesWith(numbering.numberEntry)
  engine.admitWritesWith(numbering.admit)
  const writeDeps: WriteRoutingDeps = {
    nodeId,
    numbering,
    coordinator: allocationView.routing,
    refreshAllocation: allocationView.refresh,
    engine,
    transport: config.transport,
    getReplicationLog,
    resetReplicationLog: seedReplicationLog,
    partitionWriteQueues: createPartitionWriteQueues(),
    catchUp: createCatchUpState(),
    resolveNodeTargets,
    waitForActiveReplicas: config.replication?.waitForActiveReplicas,
    memoryView: memoryReporting.view,
    writePressure: memoryReporting.writePressure,
    writeProjection: memoryReporting.writeProjection,
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

  const bootstrapPartition = createPartitionBootstrap({
    nodeId,
    engine,
    coordinator: config.coordinator,
    transport: config.transport,
    state: bootstrapSyncState,
    resolveNodeTargets,
    getReplicationLog,
    seedReplicationLog,
    onError: forwardOnError,
    snapshotSpoolDirectory: snapshotSpool.path,
  })

  const lifecycle: DataNodeHandle = createDataNodeLifecycle({
    registration,
    currentRegistration: memoryReporting.currentRegistration,
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
      replicationLogs.delete(buildReplicationLogKey(indexName, partitionId))
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
      nodeLeftDelayMs: config.controller?.nodeLeftDelayMs ?? DEFAULT_CONTROLLER_CONFIG.nodeLeftDelayMs,
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

  const readDeps: ClusterReadDeps = { config: routingConfig, nodeId, engine, resolveNodeTargets }

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
      await allocationView.start()

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

      await memoryReporting.start()
      await lifecycle.join()

      if (controller !== null) {
        await controller.start()
      }

      if (hasDataRole) {
        const dataHandler = createDataNodeHandler({
          nodeId,
          engine,
          coordinator: config.coordinator,
          allocations: allocationView,
          writeDeps,
          snapshotSyncState: snapshotSyncHandlerState,
          snapshotSpoolDirectory: snapshotSpool.path,
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
      allocationView.stop()

      if (unregisterHandler !== null) {
        unregisterHandler()
        unregisterHandler = null
      }
      if (unregisterNotReadyHandler !== null) {
        unregisterNotReadyHandler()
        unregisterNotReadyHandler = null
      }

      await lifecycle.shutdown()
      memoryReporting.stop()

      if (controller !== null) {
        await controller.shutdown()
      }

      await Promise.all([...heldPartitionWrites])

      await engine.shutdown()
      await snapshotSpool.dispose()
    },
  }

  bindWriteBlockLookup(node, async indexName => {
    const table = await routableAllocation(writeDeps.coordinator, indexName).catch(() => null)
    return table === null ? null : findWriteBlock(table, memoryReporting.view)
  })
  return node

  function resolveSnapshotHeaderMetadata(indexName: string, partitionId: number | null) {
    return nodeSnapshotHeaderMetadata(
      { coordinator: config.coordinator, engine, getReplicationLog },
      indexName,
      partitionId,
    )
  }
}

export type {
  ClusterControllerConfig,
  ClusterMemoryConfig,
  ClusterNamespace,
  ClusterNode,
  ClusterNodeConfig,
  ClusterNodeInfo,
  ClusterQueryConfig,
  CreateIndexOptions,
  NodeReadiness,
} from './types'
export { DEFAULT_CAPACITY, DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from './types'
