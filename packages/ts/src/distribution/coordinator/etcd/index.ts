import { Etcd3, type IKeyValue, type Watcher } from 'etcd3'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { SchemaDefinition } from '../../../types/schema'
import type {
  AllocationEvent,
  AllocationTable,
  ClusterCoordinator,
  NodeEvent,
  NodeRegistration,
  PartitionState,
  SchemaEvent,
} from '../types'
import { LeaseManager } from './leases'
import {
  deserializeAllocationTable,
  deserializeNodeRegistration,
  deserializeSchema,
  serializeAllocationTable,
  serializeNodeRegistration,
  serializeSchema,
} from './serialization'
import {
  buildKey,
  DEFAULT_ETCD_CONFIG,
  ETCD_KEY_ALLOCATION,
  ETCD_KEY_NODES,
  ETCD_KEY_PARTITION,
  ETCD_KEY_SCHEMA,
  type EtcdCoordinatorConfig,
} from './types'
import { MAX_WATCHERS, validateNodeId, validatePartitionState } from './validation'

export type { EtcdCoordinatorConfig } from './types'
export { validateNodeId } from './validation'

export function createEtcdCoordinator(config?: Partial<EtcdCoordinatorConfig>): ClusterCoordinator {
  const resolvedConfig: EtcdCoordinatorConfig = {
    ...DEFAULT_ETCD_CONFIG,
    ...config,
  }

  const client = new Etcd3({ hosts: resolvedConfig.endpoints })
  const leaseManager = new LeaseManager()
  const watchers = new Set<Watcher>()
  let isShutdown = false

  function assertNotShutdown(): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Coordinator has been shut down')
    }
  }

  function nodeKey(nodeId: string): string {
    return buildKey(resolvedConfig.keyPrefix, ETCD_KEY_NODES, nodeId)
  }

  function allocationKey(indexName: string): string {
    return buildKey(resolvedConfig.keyPrefix, ETCD_KEY_ALLOCATION, indexName)
  }

  function partitionKey(indexName: string, partitionId: number): string {
    return buildKey(resolvedConfig.keyPrefix, ETCD_KEY_PARTITION, indexName, String(partitionId))
  }

  function schemaKey(indexName: string): string {
    return buildKey(resolvedConfig.keyPrefix, ETCD_KEY_SCHEMA, indexName)
  }

  function leaseKey(key: string): string {
    return buildKey(resolvedConfig.keyPrefix, 'lease', key)
  }

  function genericKey(key: string): string {
    return buildKey(resolvedConfig.keyPrefix, 'kv', key)
  }

  function extractSuffix(fullKey: string, prefix: string): string {
    return fullKey.slice(prefix.length + 1)
  }

  function addWatcher(watcher: Watcher): void {
    if (watchers.size >= MAX_WATCHERS) {
      watcher.cancel().catch(() => {})
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Maximum watcher limit (${MAX_WATCHERS}) reached`, {
        currentCount: watchers.size,
      })
    }
    watchers.add(watcher)
  }

  function removeWatcher(watcher: Watcher): void {
    watcher.cancel().catch(() => {})
    watchers.delete(watcher)
  }

  const coordinator: ClusterCoordinator = {
    async registerNode(registration: NodeRegistration): Promise<void> {
      assertNotShutdown()
      validateNodeId(registration.nodeId)
      const ttl = resolvedConfig.nodeHeartbeatTtlSeconds
      const lease = client.lease(ttl)
      await lease.grant()

      const key = nodeKey(registration.nodeId)
      const data = Buffer.from(serializeNodeRegistration(registration))
      await lease.put(key).value(data).exec()

      const existing = leaseManager.get(key)
      if (existing !== undefined) {
        await existing.lease.revoke().catch(() => {})
      }
      leaseManager.track(key, lease, registration.nodeId)
    },

    async deregisterNode(nodeId: string): Promise<void> {
      assertNotShutdown()
      validateNodeId(nodeId)
      const key = nodeKey(nodeId)
      const entry = leaseManager.remove(key)
      if (entry !== undefined) {
        await entry.lease.revoke().catch(() => {})
      }
      await client.delete().key(key).exec()
    },

    async listNodes(): Promise<NodeRegistration[]> {
      assertNotShutdown()
      const prefix = buildKey(resolvedConfig.keyPrefix, ETCD_KEY_NODES)
      const result = await client.getAll().prefix(prefix).buffers()
      const nodes: NodeRegistration[] = []
      for (const key of Object.keys(result)) {
        const buf = result[key]
        if (buf !== undefined) {
          nodes.push(deserializeNodeRegistration(buf))
        }
      }
      return nodes
    },

    async watchNodes(handler: (event: NodeEvent) => void): Promise<() => void> {
      assertNotShutdown()
      const prefix = buildKey(resolvedConfig.keyPrefix, ETCD_KEY_NODES)
      const watcher = await client.watch().prefix(prefix).create()
      addWatcher(watcher)

      watcher.on('put', (kv: IKeyValue) => {
        try {
          const registration = deserializeNodeRegistration(kv.value)
          handler({ type: 'node_joined', nodeId: registration.nodeId, registration })
        } catch (_) {
          /* malformed registration data should not crash the watcher */
        }
      })

      watcher.on('delete', (kv: IKeyValue) => {
        const fullKey = kv.key.toString()
        const nodeId = extractSuffix(fullKey, prefix)
        handler({ type: 'node_left', nodeId, registration: null })
      })

      return () => removeWatcher(watcher)
    },

    async getAllocation(indexName: string): Promise<AllocationTable | null> {
      assertNotShutdown()
      const key = allocationKey(indexName)
      const buf = await client.get(key).buffer()
      if (buf === null) {
        return null
      }
      return deserializeAllocationTable(buf)
    },

    async putAllocation(indexName: string, table: AllocationTable, expectedVersion?: number | null): Promise<boolean> {
      assertNotShutdown()
      const key = allocationKey(indexName)
      const data = Buffer.from(serializeAllocationTable(table))

      if (expectedVersion === undefined) {
        await client.put(key).value(data).exec()
        return true
      }

      if (expectedVersion === null) {
        const txn = await client.if(key, 'Create', '==', 0).then(client.put(key).value(data)).commit()
        return txn.succeeded
      }

      const response = await client.get(key).exec()
      if (response.kvs.length === 0) {
        return false
      }
      const kv = response.kvs[0]
      const currentTable = deserializeAllocationTable(Buffer.from(kv.value))
      if (currentTable.version !== expectedVersion) {
        return false
      }

      const txn = await client.if(key, 'Mod', '==', kv.mod_revision).then(client.put(key).value(data)).commit()
      return txn.succeeded
    },

    async watchAllocation(handler: (event: AllocationEvent) => void): Promise<() => void> {
      assertNotShutdown()
      const prefix = buildKey(resolvedConfig.keyPrefix, ETCD_KEY_ALLOCATION)
      const watcher = await client.watch().prefix(prefix).create()
      addWatcher(watcher)

      watcher.on('put', (kv: IKeyValue) => {
        try {
          const table = deserializeAllocationTable(kv.value)
          handler({ indexName: table.indexName, table })
        } catch (_) {
          /* malformed allocation data should not crash the watcher */
        }
      })

      return () => removeWatcher(watcher)
    },

    async getPartitionState(indexName: string, partitionId: number): Promise<PartitionState> {
      assertNotShutdown()
      const key = partitionKey(indexName, partitionId)
      const value = await client.get(key).string()
      if (value === null) {
        return 'UNASSIGNED'
      }
      return validatePartitionState(value)
    },

    async putPartitionState(indexName: string, partitionId: number, state: PartitionState): Promise<void> {
      assertNotShutdown()
      const key = partitionKey(indexName, partitionId)
      await client.put(key).value(state).exec()
    },

    async acquireLease(key: string, nodeId: string, ttlMs: number): Promise<boolean> {
      assertNotShutdown()
      const etcdKey = leaseKey(key)
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))

      const existing = leaseManager.get(etcdKey)
      if (existing !== undefined && existing.nodeId === nodeId) {
        try {
          await existing.lease.keepaliveOnce()
          return true
        } catch (_) {
          leaseManager.remove(etcdKey)
        }
      }

      const lease = client.lease(ttlSeconds)
      await lease.grant()
      const txn = await client.if(etcdKey, 'Create', '==', 0).then(lease.put(etcdKey).value(nodeId)).commit()

      if (!txn.succeeded) {
        await lease.revoke().catch(() => {})
        const currentValue = await client.get(etcdKey).string()
        return currentValue === nodeId
      }

      leaseManager.track(etcdKey, lease, nodeId)
      return true
    },

    async renewLease(key: string, nodeId: string, _ttlMs: number): Promise<boolean> {
      assertNotShutdown()
      const etcdKey = leaseKey(key)

      const entry = leaseManager.getByNodeId(etcdKey, nodeId)
      if (entry === undefined) {
        return false
      }

      try {
        await entry.lease.keepaliveOnce()
        return true
      } catch (_) {
        leaseManager.remove(etcdKey)
        return false
      }
    },

    async releaseLease(key: string): Promise<void> {
      assertNotShutdown()
      const etcdKey = leaseKey(key)
      const entry = leaseManager.remove(etcdKey)
      if (entry !== undefined) {
        await entry.lease.revoke().catch(() => {})
      }
      await client.delete().key(etcdKey).exec()
    },

    async get(key: string): Promise<Uint8Array | null> {
      assertNotShutdown()
      const etcdKey = genericKey(key)
      const buf = await client.get(etcdKey).buffer()
      if (buf === null) {
        return null
      }
      return new Uint8Array(buf)
    },

    async compareAndSet(key: string, expected: Uint8Array | null, value: Uint8Array): Promise<boolean> {
      assertNotShutdown()
      const etcdKey = genericKey(key)
      const newValue = Buffer.from(value)

      if (expected === null) {
        const txn = await client.if(etcdKey, 'Create', '==', 0).then(client.put(etcdKey).value(newValue)).commit()
        return txn.succeeded
      }

      const expectedBuf = Buffer.from(expected)
      const txn = await client
        .if(etcdKey, 'Value', '==', expectedBuf)
        .then(client.put(etcdKey).value(newValue))
        .commit()
      return txn.succeeded
    },

    async getSchema(indexName: string): Promise<SchemaDefinition | null> {
      assertNotShutdown()
      const key = schemaKey(indexName)
      const buf = await client.get(key).buffer()
      if (buf === null) {
        return null
      }
      return deserializeSchema(buf)
    },

    async putSchema(indexName: string, schema: SchemaDefinition): Promise<void> {
      assertNotShutdown()
      const key = schemaKey(indexName)
      await client.put(key).value(serializeSchema(schema)).exec()
    },

    async watchSchemas(handler: (event: SchemaEvent) => void): Promise<() => void> {
      assertNotShutdown()
      const prefix = buildKey(resolvedConfig.keyPrefix, ETCD_KEY_SCHEMA)
      const watcher = await client.watch().prefix(prefix).create()
      addWatcher(watcher)

      watcher.on('put', (kv: IKeyValue) => {
        try {
          const schema = deserializeSchema(kv.value)
          const fullKey = kv.key.toString()
          const indexName = extractSuffix(fullKey, prefix)
          handler({ type: 'schema_created', indexName, schema })
        } catch (_) {
          /* malformed schema data should not crash the watcher */
        }
      })

      watcher.on('delete', (kv: IKeyValue) => {
        const fullKey = kv.key.toString()
        const indexName = extractSuffix(fullKey, prefix)
        handler({ type: 'schema_dropped', indexName, schema: null })
      })

      return () => removeWatcher(watcher)
    },

    async getLeaseHolder(key: string): Promise<string | null> {
      assertNotShutdown()
      const etcdKey = leaseKey(key)
      const value = await client.get(etcdKey).string()
      return value ?? null
    },

    async shutdown(): Promise<void> {
      if (isShutdown) {
        return
      }
      isShutdown = true

      const cancelPromises: Promise<void>[] = []
      for (const watcher of watchers) {
        cancelPromises.push(watcher.cancel().catch(() => {}))
      }
      await Promise.all(cancelPromises)
      watchers.clear()

      await leaseManager.revokeAll()

      client.close()
    },
  }

  return coordinator
}
