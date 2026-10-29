import { ErrorCodes, NarsilError } from '../../errors'
import { bindRerankWindowSource, rerankWindowCapOf } from '../../narsil/internals'
import { bindWriteBlockLookup } from '../../narsil/write-blocks'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../cluster/constants'
import type { ControllerNode } from '../cluster/controller/types'
import { createDataNodeLifecycle } from '../cluster/node-lifecycle'
import type { DataNodeHandle } from '../cluster/node-lifecycle/types'
import type { NodeRole } from '../coordinator/types'
import { openSnapshotSpoolDirectory } from '../replication/snapshot-spool'
import type { ReplicationLog } from '../replication/types'
import { cleanupRemovedPartition, releaseTornDownIndex } from './bootstrap-cleanup'
import { clearBootstrapSyncIndex, createBootstrapSyncState, hasCompletedBootstrapSync } from './bootstrap-sync'
import { startCatchUpPump, stopCatchUpPump } from './catch-up'
import { createClusterNamespace } from './cluster-namespace'
import { createNodeController } from './controller-role'
import { decommissionNode } from './decommission'
import { createAllocationErrorForwarder, createErrorForwarder } from './error-forwarding'
import { servingNameOf } from './generation-routing'
import { type ClusterLocalEngine, createClusterLocalEngine } from './local-engine'
import { orphanedIndexError, reconcileLocalIndexes } from './local-index-reconcile'
import { seedReopenedPrimaryLogs } from './local-replication'
import { findWriteBlock } from './memory/write-block'
import { createDataNodeHandler } from './message-handler'
import { resolveNodeId } from './node-identity'
import { createClusterNodeOperations } from './node-operations'
import { createNodeWiring } from './node-wiring'
import { createCoordinatorTiming, timeCoordinatorCalls } from './observability/coordinator-timing'
import { createClusterOperationTracker } from './operation-tracker'
import { createPartitionBootstrap } from './partition-bootstrap'
import type { ClusterReadDeps } from './reads'
import { requestReplicationFactor } from './replication-factor'
import { replicationLogKey as buildReplicationLogKey, deleteIndexReplicationLogs } from './replication-logs'
import { requestRebalance, waitForSwap } from './reshard/request'
import { createReshardState, forgetReshardIndex, forgetReshardPartition, stopEveryReshardJob } from './reshard/state'
import { routableAllocation } from './routable-allocation'
import { createSnapshotSyncHandlerState, nodeSnapshotHeaderMetadata } from './snapshot-sync-handler'
import { createMultiplexedControllerTransport, createNotReadyHandler } from './transport-listener'
import type { ClusterNode, ClusterNodeConfig } from './types'
import { validateClusterNodeConfig } from './validate-config'

/**
 * Builds one node of a cluster, ready to join.
 *
 * The node is idle until you call {@link ClusterNode.start}, which registers
 * it, takes on the partitions the controller allocates to it, and starts
 * answering. A node whose roles include `controller` stands for election and
 * runs allocation for the whole cluster while it holds the lease.
 *
 * @param callerConfig - The coordinator, the transport, this node's address, and the
 * settings for the engine it runs locally.
 * @returns The node, ready for {@link ClusterNode.start}.
 *
 * @public
 */
export async function createClusterNode(callerConfig: ClusterNodeConfig): Promise<ClusterNode> {
  validateClusterNodeConfig(callerConfig)
  const coordinatorTiming = createCoordinatorTiming()
  const config = { ...callerConfig, coordinator: timeCoordinatorCalls(callerConfig.coordinator, coordinatorTiming) }

  const roles: ReadonlyArray<NodeRole> = config.roles ?? ['data', 'coordinator', 'controller']

  const bootstrapSyncState = createBootstrapSyncState()
  const snapshotSyncHandlerState = createSnapshotSyncHandlerState()
  const replicationLogs = new Map<string, ReplicationLog>()
  const reshard = createReshardState()
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
    onIndexClose: indexName => {
      deleteIndexReplicationLogs(replicationLogs, indexName)
      forgetReshardIndex(reshard, indexName)
    },
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

  const wiring = createNodeWiring({
    config,
    nodeId,
    roles,
    engine,
    replicationLogs,
    reshard,
    renewRegistration: () => lifecycle.renewRegistration(),
  })
  const { registration, allocationView, routingConfig, memoryReporting, writeDeps } = wiring
  const { getReplicationLog, seedReplicationLog, resolveNodeTargets } = wiring

  const forwardOnError = createErrorForwarder(config.onError)
  const forwardAllocationError = createAllocationErrorForwarder(forwardOnError)
  const cleanupDeps = { engine, coordinator: config.coordinator, nodeId, onError: forwardOnError }

  const hasDataRole = roles.includes('data')
  const hasControllerRole = roles.includes('controller')
  const controllerTransport = hasDataRole ? createMultiplexedControllerTransport(config.transport, nodeId) : null

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
    partitionWriteQueues: writeDeps.partitionWriteQueues,
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
      const removedIndexUuid = engine.indexUuidOf(indexName)
      forgetReshardPartition(reshard, indexName, partitionId)
      clearBootstrapSyncIndex(bootstrapSyncState, indexName, partitionId)
      replicationLogs.delete(buildReplicationLogKey(indexName, partitionId))
      trackHeldPartitionWrite(engine.forgetHeldPartition(indexName, partitionId))
      void cleanupRemovedPartition(indexName, partitionId, { ...cleanupDeps, removedIndexUuid })
    },
    onIndexTornDown: (indexName: string) => {
      const removedIndexUuid = engine.indexUuidOf(indexName)
      void releaseTornDownIndex(indexName, { ...cleanupDeps, removedIndexUuid })
    },
  })

  if (hasControllerRole) {
    controller = createNodeController(config, nodeId, controllerTransport?.transport ?? config.transport, {
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
  const servingName = (indexName: string) => servingNameOf(allocationView.routing, indexName)

  const cluster = createClusterNamespace({
    nodeId,
    roles,
    coordinator: config.coordinator,
    lifecycle: () => lifecycle,
    controller: () => controller,
    isShutdown: () => isShutdown,
    isServing: () => serving,
    trackOp,
    requestReplicationFactor: async (indexName, factor) =>
      requestReplicationFactor(config, nodeId, await servingName(indexName), factor),
    observability: {
      nodeId,
      coordinator: allocationView.routing,
      catchUp: writeDeps.catchUp,
      replicationLogOf: wiring.existingReplicationLog,
      timing: coordinatorTiming,
    },
  })

  const node: ClusterNode = {
    get nodeId(): string {
      return nodeId
    },

    get roles(): ReadonlyArray<NodeRole> {
      return roles
    },

    open: (indexName: string) => trackOp(indexName, async () => engine.open(await servingName(indexName))),
    close: (indexName: string) => transitionIndex(indexName, async () => engine.close(await servingName(indexName))),
    registerRerankAdapter: (name, adapter) => engine.registerRerankAdapter(name, adapter),

    ...createClusterNodeOperations({
      trackOp,
      transitionIndex,
      servingName,
      requestRebalance: (indexName, count) => requestRebalance(config, nodeId, indexName, count),
      waitForRebalance: (indexName, job) => waitForSwap(config, indexName, job, guardShutdown),
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
      isOrphaned: (indexName: string) => orphanedIndexes.has(indexName),
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
          onError: forwardOnError,
        })
        const listener = controllerTransport !== null ? controllerTransport.createHandler(dataHandler) : dataHandler
        unregisterHandler = await config.transport.listen(listener)
        startCatchUpPump(writeDeps.catchUp, writeDeps)
      }
      serving = true
    },

    async decommission(options?: { signal?: AbortSignal }) {
      guardShutdown()
      await decommissionNode(
        { nodeId, coordinator: config.coordinator, registration, lifecycle, node },
        options?.signal,
      )
    },

    async shutdown() {
      stopEveryReshardJob(reshard)
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
  bindRerankWindowSource(node, () => rerankWindowCapOf(engine))
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
