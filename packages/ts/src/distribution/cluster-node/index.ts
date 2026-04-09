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
import type { NodeRegistration, NodeRole } from '../coordinator/types'
import type { ClusterNamespace, ClusterNode, ClusterNodeConfig, CreateIndexOptions } from './types'
import { DEFAULT_CAPACITY } from './types'
import { routeCreateIndex, routeInsert, routeInsertBatch, routeRemove, routeRemoveBatch } from './write-routing'

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

  let lifecycle: DataNodeHandle | null = null
  let controller: ControllerNode | null = null
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
      transport: config.transport,
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
      return trackOp(() => routeInsert(indexName, document, docId, nodeId, config.coordinator, engine))
    },

    async insertBatch(indexName, documents) {
      return trackOp(() => routeInsertBatch(indexName, documents, nodeId, config.coordinator, engine))
    },

    async remove(indexName, docId) {
      return trackOp(() => routeRemove(indexName, docId, nodeId, config.coordinator, engine))
    },

    async removeBatch(indexName, docIds) {
      return trackOp(() => routeRemoveBatch(indexName, docIds, nodeId, config.coordinator, engine))
    },

    async query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>> {
      return trackOp(() => engine.query<T>(indexName, params))
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
