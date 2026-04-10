import { decode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil } from '../../narsil'
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
import { createFetchMessage, validateFetchResultPayload } from '../query/codec'
import { distributedQuery } from '../query/routing'
import { selectReplica } from '../query/selection'
import type { DistributedQueryResult } from '../query/types'
import type { FetchDocumentId, TransportMessage } from '../transport/types'
import { createDataNodeHandler } from './message-handler'
import { distributedResultToLocal, localParamsToWire } from './query-conversion'
import { createMultiplexedControllerTransport } from './transport-listener'
import type { ClusterNamespace, ClusterNode, ClusterNodeConfig, CreateIndexOptions } from './types'
import { DEFAULT_CAPACITY } from './types'
import {
  resolvePartitionId,
  routeCreateIndex,
  routeInsert,
  routeInsertBatch,
  routeRemove,
  routeRemoveBatch,
  type WriteRoutingDeps,
} from './write-routing'

const SPEC_VERSION = '1.0'

export async function createClusterNode(config: ClusterNodeConfig): Promise<ClusterNode> {
  validateClusterNodeConfig(config)

  const nodeId = config.nodeId ?? generateId()
  const roles: ReadonlyArray<NodeRole> = config.roles ?? ['data', 'coordinator', 'controller']
  const capacity = config.capacity ?? DEFAULT_CAPACITY

  const engine = await createNarsil(config.engine)

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
    resolveNodeTargets,
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
      onBootstrapPartition: async (indexName: string, _partitionId: number, _primaryNodeId: string) => {
        try {
          const schema = await config.coordinator.getSchema(indexName)
          if (schema === null) {
            return false
          }

          const existing = engine.listIndexes().find(idx => idx.name === indexName)
          if (existing === undefined) {
            await engine.createIndex(indexName, { schema })
          }
          return true
        } catch (err) {
          if (config.onError !== undefined) {
            const wrappedError = err instanceof Error ? err : new Error(String(err))
            config.onError(wrappedError)
          }
          return false
        }
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
        const documents = await fetchDistributedDocuments<T>(indexName, distributed, allocation)
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
        const dataHandler = createDataNodeHandler({ nodeId, engine })
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

  async function resolveNodeTargets(targetNodeId: string): Promise<string[]> {
    const targets = [targetNodeId]
    const nodes = await config.coordinator.listNodes()
    const registration = nodes.find(node => node.nodeId === targetNodeId)
    if (registration !== undefined && registration.address.length > 0 && registration.address !== targetNodeId) {
      targets.push(registration.address)
    }
    return targets
  }

  async function fetchDistributedDocuments<T>(
    indexName: string,
    result: DistributedQueryResult,
    allocation: AllocationTable,
  ): Promise<Map<string, T>> {
    const partitionCount = allocation.assignments.size
    const nodeToDocumentIds = new Map<string, FetchDocumentId[]>()

    for (const entry of result.scored) {
      const partitionId = resolvePartitionId(entry.docId, partitionCount)
      const assignment = allocation.assignments.get(partitionId)
      if (assignment === undefined) {
        continue
      }
      const selectedNodeId = selectReplica(assignment, nodeId, undefined, partitionId)
      if (selectedNodeId === null) {
        continue
      }
      let documentIds = nodeToDocumentIds.get(selectedNodeId)
      if (documentIds === undefined) {
        documentIds = []
        nodeToDocumentIds.set(selectedNodeId, documentIds)
      }
      documentIds.push({ docId: entry.docId, partitionId })
    }

    const documents = new Map<string, T>()
    for (const [targetNodeId, documentIds] of nodeToDocumentIds) {
      if (targetNodeId === nodeId) {
        for (const { docId } of documentIds) {
          const document = await engine.get(indexName, docId)
          if (document !== undefined) {
            documents.set(docId, document as T)
          }
        }
        continue
      }

      const fetchMessage = createFetchMessage(
        {
          indexName,
          documentIds,
          fields: null,
          highlight: null,
        },
        nodeId,
      )
      const response = await sendToNode(targetNodeId, fetchMessage)
      const decoded = decode(response.payload)
      const payload = validateFetchResultPayload(decoded)
      for (const fetched of payload.documents) {
        documents.set(fetched.docId, fetched.document as T)
      }
    }

    return documents
  }

  async function sendToNode(targetNodeId: string, message: TransportMessage): Promise<TransportMessage> {
    const targets = await resolveNodeTargets(targetNodeId)
    let lastError: unknown
    for (const target of targets) {
      try {
        return await config.transport.send(target, message)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

function validateClusterNodeConfig(config: ClusterNodeConfig): void {
  if (config.address.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'ClusterNodeConfig.address must not be empty')
  }

  if (config.roles !== undefined) {
    if (config.roles.length === 0) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'ClusterNodeConfig.roles must contain at least one role')
    }

    const validRoles = new Set<NodeRole>(['data', 'coordinator', 'controller'])
    for (const role of config.roles) {
      if (!validRoles.has(role)) {
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Invalid role: '${role}'`, { role })
      }
    }
  }

  if (config.capacity !== undefined) {
    if (config.capacity.memoryBytes <= 0 || !Number.isFinite(config.capacity.memoryBytes)) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        'ClusterNodeConfig.capacity.memoryBytes must be a positive finite number',
      )
    }
    if (config.capacity.cpuCores <= 0 || !Number.isInteger(config.capacity.cpuCores)) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'ClusterNodeConfig.capacity.cpuCores must be a positive integer')
    }
  }
}

export type { ClusterNamespace, ClusterNode, ClusterNodeConfig, ClusterNodeInfo, CreateIndexOptions } from './types'
export { DEFAULT_CAPACITY, DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from './types'
