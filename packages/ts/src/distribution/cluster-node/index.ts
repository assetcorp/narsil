import { ErrorCodes, NarsilError } from '../../errors'
import { createBackupService } from '../backups/service'
import type { ControllerNode } from '../cluster/controller/types'
import type { NodeRole } from '../coordinator/types'
import { openSnapshotSpoolDirectory } from '../replication/snapshot-spool'
import type { ReplicationLog } from '../replication/types'
import { createAnalysisView } from './analysis-change/view'
import { createBm25View } from './bm25-view'
import { clearBootstrapSyncIndex, createBootstrapSyncState, hasCompletedBootstrapSync } from './bootstrap-sync'
import { startCatchUpPump, stopCatchUpPump } from './catch-up'
import { createClusterNamespace } from './cluster-namespace'
import { createNodeController } from './controller-role'
import { createCopyFailures } from './copy-failure'
import { decommissionNode } from './decommission'
import { createClusterDeviceSync } from './device-sync'
import { createAllocationErrorForwarder, createErrorForwarder } from './error-forwarding'
import { servingNameOf } from './generation-routing'
import { type ClusterLocalEngine, createClusterLocalEngine } from './local-engine'
import { orphanedIndexError, settleLocalIndexes } from './local-index-reconcile'
import { seedReopenedPrimaryLogs } from './local-replication'
import { bindNodeSources } from './node-bindings'
import { resolveNodeId } from './node-identity'
import { createNodeLifecycle } from './node-lifecycle'
import { createClusterNodeOperations } from './node-operations'
import { createNodeWiring } from './node-wiring'
import { createCoordinatorTiming, timeCoordinatorCalls } from './observability/coordinator-timing'
import { createClusterOperationTracker } from './operation-tracker'
import { createPartitionBootstrap } from './partition-bootstrap'
import { listenForPeers, listenUntilJoined } from './peer-listener'
import { createClusterQuerySuggestions } from './query-suggestions'
import { requestReplicationFactor } from './replication-factor'
import { replicationLogKey as buildReplicationLogKey, deleteIndexReplicationLogs } from './replication-logs'
import { requestRebalance, waitForSwap } from './reshard/request'
import { createReshardState, forgetReshardIndex, stopEveryReshardJob } from './reshard/state'
import { createSearchContextRegistry } from './search-contexts'
import { clusterNodeEngine } from './server-engine'
import { createSettlingWrites } from './settling-writes'
import { createSnapshotSyncHandlerState } from './snapshot-sync-handler'
import { createMultiplexedControllerTransport } from './transport-listener'
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
  const heldPartitionWrites = createSettlingWrites(forwardOnError)

  let controller: ControllerNode | null = null
  let unregisterHandler: (() => void) | null = null
  let unregisterNotReadyHandler: (() => void) | null = null
  const searchContexts = hasDataRole ? createSearchContextRegistry() : undefined
  let serving = false
  let isShutdown = false

  const copyFailures = createCopyFailures({
    engine,
    writeDeps,
    forgetPartitionLog: (indexName, partitionId) => {
      clearBootstrapSyncIndex(bootstrapSyncState, indexName, partitionId)
      replicationLogs.delete(buildReplicationLogKey(indexName, partitionId))
    },
    isShutdown: () => isShutdown,
    onError: forwardOnError,
  })
  writeDeps.copyFailed = copyFailures.isFailed
  writeDeps.copyUnlisted = copyFailures.isUnlisted
  writeDeps.stopped = () => isShutdown
  engine.isolateCopyFailures(copyFailures.record)

  const bootstrapPartition = createPartitionBootstrap({
    nodeId,
    engine,
    coordinator: config.coordinator,
    transport: config.transport,
    state: bootstrapSyncState,
    resolveNodeTargets: wiring.resolveRegisteredNodeTargets,
    getReplicationLog,
    seedReplicationLog,
    partitionWriteQueues: writeDeps.partitionWriteQueues,
    onError: forwardOnError,
    snapshotSpoolDirectory: snapshotSpool.path,
  })

  const lifecycle = createNodeLifecycle({
    config,
    registration,
    currentRegistration: memoryReporting.currentRegistration,
    engine,
    writeDeps,
    reshard,
    bootstrapSyncState,
    replicationLogs,
    copyFailures,
    bootstrapPartition,
    trackHeldPartitionWrite: heldPartitionWrites.track,
    cleanupDeps,
  })

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
  const suggestions = createClusterQuerySuggestions({
    config,
    nodeId,
    engine,
    isController: () => controller?.isActive ?? false,
    guard: guardShutdown,
    trackOp,
    isOrphaned: indexName => orphanedIndexes.has(indexName),
    onError: forwardOnError,
  })
  const backups = createBackupService({
    config,
    nodeId,
    guard: guardShutdown,
    isController: () => controller?.isActive ?? false,
    onError: forwardOnError,
    queryHistory: suggestions.queryHistory,
  })

  if (hasControllerRole) {
    controller = createNodeController(config, nodeId, controllerTransport?.transport ?? config.transport, {
      onError: forwardAllocationError,
      onElectionError: forwardOnError,
      extraMessages: (message, respond) =>
        backups.controllerMessages(message, respond) || suggestions.controllerMessages(message, respond),
    })
  }

  const bm25View = createBm25View({ coordinator: config.coordinator, engine, onError: forwardOnError })
  const analysisView = createAnalysisView({ coordinator: config.coordinator, engine, onError: forwardOnError })
  const readDeps = { config: routingConfig, nodeId, engine, resolveNodeTargets, searchContexts, bm25View, analysisView }
  const servingName = (indexName: string) => servingNameOf(allocationView.routing, indexName)
  const deviceSync = createClusterDeviceSync({
    ...cleanupDeps,
    config,
    writeDeps,
    refreshAllocation: allocationView.refresh,
    spoolDirectory: snapshotSpool.path,
    guard: guardShutdown,
  })

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
    backups: backups.namespace,
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
      guardShutdown,
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
      suggestionHooks: suggestions.hooks,
    }),
    updateSync: (indexName, setting) => trackOp(indexName, () => deviceSync.updateSync(indexName, setting)),
    getSync: indexName => trackOp(indexName, () => deviceSync.getSync(indexName)),

    cluster,

    async start() {
      guardShutdown()
      await allocationView.start()
      await bm25View.start()
      await analysisView.start()
      await deviceSync.start()

      const reconcileDeps = { engine, coordinator: config.coordinator, nodeId, onError: forwardOnError }
      await settleLocalIndexes(reconcileDeps, orphanedIndexes, analysisView.settle)

      unregisterNotReadyHandler = await listenUntilJoined(config, nodeId, hasDataRole)

      await memoryReporting.start()
      await lifecycle.join()
      await suggestions.start()

      if (controller !== null) {
        await controller.start()
        backups.start()
      }

      unregisterHandler = await listenForPeers({
        config,
        nodeId,
        hasControllerRole,
        controllerTransport,
        answerQueryCounts: suggestions.answerCounts,
        dataHandler: hasDataRole
          ? {
              nodeId,
              engine,
              coordinator: config.coordinator,
              allocations: allocationView,
              analysisView,
              writeDeps,
              snapshotSyncState: snapshotSyncHandlerState,
              searchContexts,
              snapshotSpoolDirectory: snapshotSpool.path,
              backups: backups.primary,
              isBootstrapSynced: (indexName: string, partitionId: number) =>
                hasCompletedBootstrapSync(bootstrapSyncState, indexName, partitionId),
              onError: forwardOnError,
            }
          : null,
      })
      if (hasDataRole) startCatchUpPump(writeDeps.catchUp, writeDeps)
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
      backups.stop()

      await operationTracker.drain()
      await suggestions.stop()
      allocationView.stop()
      bm25View.stop()
      analysisView.stop()
      await deviceSync.stop()

      unregisterHandler?.()
      unregisterHandler = null
      unregisterNotReadyHandler?.()
      unregisterNotReadyHandler = null
      searchContexts?.stop()

      await lifecycle.shutdown()
      memoryReporting.stop()

      if (controller !== null) {
        await controller.shutdown()
      }

      await heldPartitionWrites.settled()

      await engine.shutdown()
      await snapshotSpool.dispose()
    },
  }

  bindNodeSources(node, {
    coordinator: writeDeps.coordinator,
    engine,
    memoryView: memoryReporting.view,
    syncServing: deviceSync.serving,
  })
  suggestions.bind(node, { engine: clusterNodeEngine(node), dropIndex: name => node.dropIndex(name) })
  return node
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
