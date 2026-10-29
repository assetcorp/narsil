import type { Etcd3 as Etcd3Client, IKeyValue, Watcher } from 'etcd3'
import { ErrorCodes, NarsilError } from '../../../errors'
import { CONTROLLER_LEASE_KEY, MAX_WATCHERS } from '../constants'
import type {
  AllocationEvent,
  AllocationTable,
  ClusterCoordinator,
  NodeEvent,
  NodeRegistration,
  PartitionState,
  RegistrationLease,
} from '../types'
import { ETCD_CALL_TIMEOUT_MS, ETCD_MAX_RESPONSE_BYTES } from './constants'
import { coordinatorKeys, extractSuffix } from './keys'
import { leaseHeldFor, recordLeaseRenewal } from './lease-validity'
import { LeaseManager } from './leases'
import { loadEtcd3Module } from './loader'
import { watchPrefix } from './prefix-watch'
import { writeNodeRegistration } from './registration'
import { createEtcdWriteGuard, requireEtcdMaxRequestBytes } from './request-size'
import { etcdSecurityOptions } from './security'
import { deserializeAllocationTable, deserializeNodeRegistration, serializeAllocationTable } from './serialization'
import { probeEtcd } from './start-probe'
import { storedValueMethods } from './stored-values'
import { DEFAULT_ETCD_CONFIG, type EtcdCoordinatorConfig } from './types'
import { validateNodeId, validatePartitionState } from './validation'

export type { EtcdAuthConfig, EtcdCoordinatorConfig, EtcdTlsConfig } from './types'
export { validateNodeId } from './validation'

/**
 * Builds a coordinator backed by etcd, which stores a cluster's shared state
 * across hosts and restarts.
 *
 * etcd provides the two mechanisms that a cluster uses: leases, which expire
 * once a node misses its heartbeats, and compare-and-set writes, which stop two
 * controllers from writing conflicting state. Install `etcd3` alongside this
 * package, because it is an optional peer dependency that this call loads on
 * demand.
 *
 * The call reads from etcd once before it returns, so that a wrong
 * certificate, a wrong password, or an etcd that nobody can reach fails the
 * call itself.
 *
 * @param config - The endpoints, key prefix, heartbeat lifetime, request
 * size, TLS certificates, and etcd user to override. Every setting that you
 * leave out keeps its default.
 * @returns A coordinator that you pass as a cluster node's `coordinator`.
 * @throws A `NarsilError` with `COORDINATOR_DEPENDENCY_MISSING` when `etcd3`
 * is not installed, or with `CONFIG_INVALID` when `maxRequestBytes` is not a
 * whole number from 1,025 to 2,147,483,647, when `tls` sets one of `cert`
 * and `key` without the other or comes with an endpoint outside `https://`,
 * or when `auth` would send its password over plain HTTP to an address other
 * than a loopback one. It throws with `COORDINATOR_AUTH_FAILED` when etcd
 * refuses the user or the password, and with `COORDINATOR_UNAVAILABLE` when
 * no endpoint answers within 10 seconds or every endpoint fails the TLS
 * handshake.
 *
 * @public
 */
export async function createEtcdCoordinator(config?: Partial<EtcdCoordinatorConfig>): Promise<ClusterCoordinator> {
  const resolvedConfig: EtcdCoordinatorConfig = {
    ...DEFAULT_ETCD_CONFIG,
    ...config,
  }

  requireEtcdMaxRequestBytes(resolvedConfig.maxRequestBytes)
  const securityOptions = etcdSecurityOptions(resolvedConfig)
  const etcd3Module = await loadEtcd3Module()
  const client: Etcd3Client = new etcd3Module.Etcd3({
    hosts: resolvedConfig.endpoints,
    grpcOptions: { 'grpc.max_receive_message_length': ETCD_MAX_RESPONSE_BYTES },
    defaultCallOptions: context => (context.isStream ? {} : { deadline: Date.now() + ETCD_CALL_TIMEOUT_MS }),
    ...securityOptions,
  })
  const keys = coordinatorKeys(resolvedConfig)
  try {
    await probeEtcd(client, etcd3Module, keys.nodePrefix(), resolvedConfig.endpoints)
  } catch (error) {
    client.close()
    throw error
  }
  const guard = createEtcdWriteGuard(etcd3Module, resolvedConfig.maxRequestBytes)
  const leaseManager = new LeaseManager()
  const watchers = new Set<Watcher>()
  let isShutdown = false

  function assertNotShutdown(): void {
    if (isShutdown) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Coordinator has been shut down')
    }
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

  const watchContext = { client, addWatcher, removeWatcher, isShutdown: () => isShutdown }

  const coordinator: ClusterCoordinator = {
    async registerNode(registration: NodeRegistration): Promise<void> {
      assertNotShutdown()
      validateNodeId(registration.nodeId)

      await writeNodeRegistration(
        {
          client,
          leaseManager,
          guard,
          key: keys.node(registration.nodeId),
          ttlSeconds: resolvedConfig.nodeHeartbeatTtlSeconds,
          isShutdown: () => isShutdown,
        },
        registration,
      )
    },

    async deregisterNode(nodeId: string): Promise<void> {
      assertNotShutdown()
      validateNodeId(nodeId)
      const key = keys.node(nodeId)
      const entry = leaseManager.remove(key)
      leaseManager.forgetHolder(key)
      if (entry !== undefined) {
        await entry.lease.revoke().catch(() => {})
      }
      await client.delete().key(key).exec()
    },

    registrationLease(nodeId: string): RegistrationLease | null {
      if (isShutdown) return null
      const holder = leaseManager.holder(keys.node(nodeId))
      return holder === undefined ? null : leaseHeldFor(holder)
    },

    async confirmRegistrationLease(nodeId: string): Promise<RegistrationLease | null> {
      if (isShutdown) return null
      const holder = leaseManager.holder(keys.node(nodeId))
      if (holder === undefined) return null
      const sentAt = performance.now()
      try {
        recordLeaseRenewal(holder, sentAt, Number((await holder.keepaliveOnce()).TTL))
      } catch (_) {}
      return leaseHeldFor(holder)
    },

    async listNodes(): Promise<NodeRegistration[]> {
      assertNotShutdown()
      const prefix = keys.nodePrefix()
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
      const prefix = keys.nodePrefix()
      return watchPrefix(watchContext, prefix, {
        put(kv: IKeyValue) {
          try {
            const registration = deserializeNodeRegistration(kv.value)
            handler({ type: 'node_joined', nodeId: registration.nodeId, registration })
          } catch (_) {}
        },
        delete(fullKey: string) {
          handler({ type: 'node_left', nodeId: extractSuffix(fullKey, prefix), registration: null })
        },
      })
    },

    async getAllocation(indexName: string): Promise<AllocationTable | null> {
      assertNotShutdown()
      const key = keys.allocation(indexName)
      const buf = await client.get(key).buffer()
      if (buf === null) {
        return null
      }
      return deserializeAllocationTable(buf)
    },

    async putAllocation(
      indexName: string,
      table: AllocationTable,
      expectedVersion?: number | null,
      writerNodeId?: string,
    ): Promise<boolean> {
      assertNotShutdown()
      const key = keys.allocation(indexName)
      const data = Buffer.from(serializeAllocationTable(table))
      const write = { key, value: data, expected: null }

      if (expectedVersion === undefined) {
        await guard.send(write, () => client.put(key).value(data).exec())
        return true
      }

      if (writerNodeId === undefined || writerNodeId.length === 0) {
        return false
      }
      const controllerLeaseKey = keys.lease(CONTROLLER_LEASE_KEY)

      if (expectedVersion === null) {
        return guard.send(write, async () => {
          const txn = await client
            .if(key, 'Create', '==', 0)
            .and(controllerLeaseKey, 'Value', '==', writerNodeId)
            .then(client.put(key).value(data))
            .commit()
          return txn.succeeded
        })
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

      return guard.send(write, async () => {
        const txn = await client
          .if(key, 'Mod', '==', kv.mod_revision)
          .and(controllerLeaseKey, 'Value', '==', writerNodeId)
          .then(client.put(key).value(data))
          .commit()
        return txn.succeeded
      })
    },

    async deleteAllocation(indexName: string): Promise<void> {
      assertNotShutdown()
      await client.delete().key(keys.allocation(indexName)).exec()
    },

    async watchAllocation(handler: (event: AllocationEvent) => void): Promise<() => void> {
      assertNotShutdown()
      return watchPrefix(watchContext, keys.allocationPrefix(), {
        put(kv: IKeyValue) {
          try {
            const table = deserializeAllocationTable(kv.value)
            handler({ indexName: table.indexName, table })
          } catch (_) {}
        },
        delete() {},
      })
    },

    async getPartitionState(indexName: string, partitionId: number): Promise<PartitionState> {
      assertNotShutdown()
      const key = keys.partition(indexName, partitionId)
      const value = await client.get(key).string()
      if (value === null) {
        return 'UNASSIGNED'
      }
      return validatePartitionState(value)
    },

    async putPartitionState(indexName: string, partitionId: number, state: PartitionState): Promise<void> {
      assertNotShutdown()
      const key = keys.partition(indexName, partitionId)
      await client.put(key).value(state).exec()
    },

    async acquireLease(key: string, nodeId: string, ttlMs: number): Promise<boolean> {
      assertNotShutdown()
      const etcdKey = keys.lease(key)
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
      const etcdKey = keys.lease(key)

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
      const etcdKey = keys.lease(key)
      const entry = leaseManager.remove(etcdKey)
      if (entry === undefined) {
        return
      }
      await entry.lease.revoke().catch(() => {})
    },

    ...storedValueMethods({
      client,
      keys,
      guard,
      assertNotShutdown,
      watchPrefix: (prefix, handlers) => watchPrefix(watchContext, prefix, handlers),
    }),

    async getLeaseHolder(key: string): Promise<string | null> {
      assertNotShutdown()
      const etcdKey = keys.lease(key)
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
