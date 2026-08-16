import { generateId } from '../../core/id-generator'
import { type ResolvedProjection, resolveProjection } from '../../core/projection'
import { ErrorCodes, NarsilError } from '../../errors'
import type { QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { createController } from '../cluster/controller'
import type { ControllerNode } from '../cluster/controller/types'
import { DEFAULT_CONTROLLER_CONFIG } from '../cluster/controller/types'
import { createDataNodeLifecycle } from '../cluster/node-lifecycle'
import type { DataNodeHandle } from '../cluster/node-lifecycle/types'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../cluster/node-lifecycle/types'
import type { AllocationTable, NodeRegistration, NodeRole } from '../coordinator/types'
import { distributedQuery } from '../query/routing'
import type { DistributedQueryResult } from '../query/types'
import type { ReplicationLog } from '../replication/types'
import type { TransportMessage } from '../transport/types'
import { cleanupRemovedPartition } from './bootstrap-cleanup'
import {
  clearBootstrapSyncIndex,
  createBootstrapSyncState,
  hasCompletedBootstrapSync,
  runBootstrapSync,
} from './bootstrap-sync'
import { createClusterLocalEngine } from './local-engine'
import { createDataNodeHandler } from './message-handler'
import {
  fetchDistributedDocuments as fetchDocumentsAcrossNodes,
  resolveNodeTargets as resolveTargetsForNode,
  sendToNode as sendMessageToNode,
} from './node-messaging'
import { distributedResultToLocal, localParamsToWire } from './query-conversion'
import {
  replicationLogKey as buildReplicationLogKey,
  getReplicationLog as readReplicationLog,
  seedReplicationLog as writeSeededReplicationLog,
} from './replication-logs'
import { createSnapshotSyncHandlerState, defaultSnapshotHeaderMetadataProvider } from './snapshot-sync-handler'
import { createMultiplexedControllerTransport } from './transport-listener'
import type { ClusterNamespace, ClusterNode, ClusterNodeConfig, CreateIndexOptions } from './types'
import { DEFAULT_CAPACITY } from './types'
import { validateClusterNodeConfig } from './validate-config'
import {
  routeCreateIndex,
  routeInsert,
  routeInsertBatch,
  routeRemove,
  routeRemoveBatch,
  type WriteRoutingDeps,
} from './write-routing'

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

  async function fetchDistributedDocuments<T>(
    indexName: string,
    result: DistributedQueryResult,
    allocation: AllocationTable,
    projection: ResolvedProjection,
  ): Promise<Map<string, T>> {
    return fetchDocumentsAcrossNodes<T>(config, nodeId, engine, indexName, result, allocation, projection)
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
    resolveNodeTargets,
    waitForActiveReplicas: config.replication?.waitForActiveReplicas,
  }

  let lifecycle: DataNodeHandle | null = null
  let controller: ControllerNode | null = null
  let unregisterHandler: (() => void) | null = null
  let isShutdown = false
  let activeOps = 0
  let drainResolve: (() => void) | null = null

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
      onBootstrapPartition: (indexName: string, partitionId: number, primaryNodeId: string) =>
        runBootstrapSync(bootstrapSyncState, indexName, partitionId, primaryNodeId, {
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
        }),
      onRemovePartition: (indexName: string, partitionId: number) => {
        clearBootstrapSyncIndex(bootstrapSyncState, indexName, partitionId)
        replicationLogs.delete(replicationLogKey(indexName, partitionId))
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

  async function trackOp<T>(fn: () => Promise<T>): Promise<T> {
    guardShutdown()
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

  const cluster: ClusterNamespace = {
    async getAllocation(indexName: string) {
      return trackOp(() => config.coordinator.getAllocation(indexName))
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

    async createIndex(name, indexConfig, options?: CreateIndexOptions) {
      return trackOp(() => routeCreateIndex(name, indexConfig, options, config.coordinator, engine))
    },

    async insert(indexName, document, docId?) {
      return trackOp(() => routeInsert(indexName, document, docId, writeDeps))
    },

    async insertBatch(indexName, documents) {
      return trackOp(() => routeInsertBatch(indexName, documents, writeDeps))
    },

    async remove(indexName, docId) {
      return trackOp(() => routeRemove(indexName, docId, writeDeps))
    },

    async removeBatch(indexName, docIds) {
      return trackOp(() => routeRemoveBatch(indexName, docIds, writeDeps))
    },

    async query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>> {
      return trackOp(async () => {
        const allocation = await config.coordinator.getAllocation(indexName)
        if (allocation === null || allocation.assignments.size === 0) {
          return engine.query<T>(indexName, params)
        }
        let hasActivePartition = false
        for (const [, assignment] of allocation.assignments) {
          if (assignment.state === 'ACTIVE') {
            hasActivePartition = true
            break
          }
        }
        if (!hasActivePartition) {
          return engine.query<T>(indexName, params)
        }
        const wireParams = localParamsToWire(params)
        const queryDeps = {
          transport: config.transport,
          sourceNodeId: nodeId,
          getAllocation: (idx: string) => config.coordinator.getAllocation(idx),
          resolveNodeTargets,
        }
        const distributed = await distributedQuery(indexName, wireParams, queryDeps)
        const documents = await fetchDistributedDocuments<T>(
          indexName,
          distributed,
          allocation,
          resolveProjection(params.document),
        )
        return distributedResultToLocal<T>(distributed, documents)
      })
    },

    cluster,

    async start() {
      guardShutdown()

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
      }
    },

    async shutdown() {
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

export type { ClusterNamespace, ClusterNode, ClusterNodeConfig, ClusterNodeInfo, CreateIndexOptions } from './types'
export { DEFAULT_CAPACITY, DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from './types'
