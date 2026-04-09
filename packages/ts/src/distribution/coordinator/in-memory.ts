import type { SchemaDefinition } from '../../types/schema'
import type {
  AllocationEvent,
  AllocationTable,
  ClusterCoordinator,
  NodeEvent,
  NodeRegistration,
  PartitionState,
  SchemaEvent,
} from './types'

interface LeaseEntry {
  nodeId: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

const NODE_HEARTBEAT_PREFIX = '_narsil/node/'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

export function createInMemoryCoordinator(): ClusterCoordinator {
  const nodes = new Map<string, NodeRegistration>()
  const allocations = new Map<string, AllocationTable>()
  const partitionStates = new Map<string, Map<number, PartitionState>>()
  const leases = new Map<string, LeaseEntry>()
  const schemas = new Map<string, SchemaDefinition>()
  const kvStore = new Map<string, Uint8Array>()

  const nodeWatchers = new Set<(event: NodeEvent) => void>()
  const allocationWatchers = new Set<(event: AllocationEvent) => void>()
  const schemaWatchers = new Set<(event: SchemaEvent) => void>()

  let isShutdown = false

  function assertNotShutdown(): void {
    if (isShutdown) {
      throw new Error('Coordinator has been shut down')
    }
  }

  function emitNodeEvent(event: NodeEvent): void {
    for (const handler of nodeWatchers) {
      try {
        handler(event)
      } catch (_) {
        /* watcher errors must not disrupt the caller */
      }
    }
  }

  function emitAllocationEvent(event: AllocationEvent): void {
    for (const handler of allocationWatchers) {
      try {
        handler(event)
      } catch (_) {
        /* watcher errors must not disrupt the caller */
      }
    }
  }

  function emitSchemaEvent(event: SchemaEvent): void {
    for (const handler of schemaWatchers) {
      try {
        handler(event)
      } catch (_) {
        /* watcher errors must not disrupt the caller */
      }
    }
  }

  function clearLeaseEntry(key: string): void {
    const entry = leases.get(key)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      leases.delete(key)
    }
  }

  function createLeaseTimer(key: string, ttlMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      leases.delete(key)
      if (key.startsWith(NODE_HEARTBEAT_PREFIX)) {
        const expiredNodeId = key.slice(NODE_HEARTBEAT_PREFIX.length)
        nodes.delete(expiredNodeId)
        emitNodeEvent({ type: 'node_left', nodeId: expiredNodeId, registration: null })
      }
    }, ttlMs)
  }

  function isLeaseValid(key: string): boolean {
    const entry = leases.get(key)
    if (entry === undefined) {
      return false
    }
    return entry.expiresAt > Date.now()
  }

  const coordinator: ClusterCoordinator = {
    async registerNode(registration: NodeRegistration): Promise<void> {
      assertNotShutdown()
      nodes.set(registration.nodeId, registration)

      const heartbeatKey = `${NODE_HEARTBEAT_PREFIX}${registration.nodeId}`
      const defaultTtlMs = 30_000
      clearLeaseEntry(heartbeatKey)
      const timer = createLeaseTimer(heartbeatKey, defaultTtlMs)
      leases.set(heartbeatKey, {
        nodeId: registration.nodeId,
        expiresAt: Date.now() + defaultTtlMs,
        timer,
      })

      emitNodeEvent({ type: 'node_joined', nodeId: registration.nodeId, registration })
    },

    async deregisterNode(nodeId: string): Promise<void> {
      assertNotShutdown()
      const existed = nodes.delete(nodeId)
      const heartbeatKey = `${NODE_HEARTBEAT_PREFIX}${nodeId}`
      clearLeaseEntry(heartbeatKey)

      if (existed) {
        emitNodeEvent({ type: 'node_left', nodeId, registration: null })
      }
    },

    async listNodes(): Promise<NodeRegistration[]> {
      assertNotShutdown()
      return Array.from(nodes.values())
    },

    async watchNodes(handler: (event: NodeEvent) => void): Promise<() => void> {
      assertNotShutdown()
      nodeWatchers.add(handler)
      return () => {
        nodeWatchers.delete(handler)
      }
    },

    async getAllocation(indexName: string): Promise<AllocationTable | null> {
      assertNotShutdown()
      return allocations.get(indexName) ?? null
    },

    async putAllocation(indexName: string, table: AllocationTable): Promise<void> {
      assertNotShutdown()
      allocations.set(indexName, table)
      emitAllocationEvent({ indexName, table })
    },

    async watchAllocation(handler: (event: AllocationEvent) => void): Promise<() => void> {
      assertNotShutdown()
      allocationWatchers.add(handler)
      return () => {
        allocationWatchers.delete(handler)
      }
    },

    async getPartitionState(indexName: string, partitionId: number): Promise<PartitionState> {
      assertNotShutdown()
      const indexStates = partitionStates.get(indexName)
      if (indexStates === undefined) {
        return 'UNASSIGNED'
      }
      return indexStates.get(partitionId) ?? 'UNASSIGNED'
    },

    async putPartitionState(indexName: string, partitionId: number, state: PartitionState): Promise<void> {
      assertNotShutdown()
      let indexStates = partitionStates.get(indexName)
      if (indexStates === undefined) {
        indexStates = new Map<number, PartitionState>()
        partitionStates.set(indexName, indexStates)
      }
      indexStates.set(partitionId, state)
    },

    async acquireLease(key: string, nodeId: string, ttlMs: number): Promise<boolean> {
      assertNotShutdown()
      if (isLeaseValid(key)) {
        const entry = leases.get(key)
        if (entry !== undefined && entry.nodeId !== nodeId) {
          return false
        }
        if (entry !== undefined && entry.nodeId === nodeId) {
          clearTimeout(entry.timer)
          const timer = createLeaseTimer(key, ttlMs)
          entry.expiresAt = Date.now() + ttlMs
          entry.timer = timer
          return true
        }
      }

      clearLeaseEntry(key)
      const timer = createLeaseTimer(key, ttlMs)
      leases.set(key, { nodeId, expiresAt: Date.now() + ttlMs, timer })
      return true
    },

    async renewLease(key: string, nodeId: string, ttlMs: number): Promise<boolean> {
      assertNotShutdown()
      const entry = leases.get(key)
      if (entry === undefined || entry.nodeId !== nodeId) {
        return false
      }
      if (!isLeaseValid(key)) {
        leases.delete(key)
        return false
      }
      clearTimeout(entry.timer)
      entry.timer = createLeaseTimer(key, ttlMs)
      entry.expiresAt = Date.now() + ttlMs
      return true
    },

    async releaseLease(key: string): Promise<void> {
      assertNotShutdown()
      clearLeaseEntry(key)
    },

    async compareAndSet(key: string, expected: Uint8Array | null, value: Uint8Array): Promise<boolean> {
      assertNotShutdown()
      const current = kvStore.get(key)

      if (expected === null) {
        if (current !== undefined) {
          return false
        }
        kvStore.set(key, new Uint8Array(value))
        return true
      }

      if (current === undefined) {
        return false
      }

      if (!bytesEqual(current, expected)) {
        return false
      }

      kvStore.set(key, new Uint8Array(value))
      return true
    },

    async getSchema(indexName: string): Promise<SchemaDefinition | null> {
      assertNotShutdown()
      return schemas.get(indexName) ?? null
    },

    async putSchema(indexName: string, schema: SchemaDefinition): Promise<void> {
      assertNotShutdown()
      schemas.set(indexName, schema)
      emitSchemaEvent({ type: 'schema_created', indexName, schema })
    },

    async watchSchemas(handler: (event: SchemaEvent) => void): Promise<() => void> {
      assertNotShutdown()
      schemaWatchers.add(handler)
      return () => {
        schemaWatchers.delete(handler)
      }
    },

    async getLeaseHolder(key: string): Promise<string | null> {
      assertNotShutdown()
      if (!isLeaseValid(key)) {
        clearLeaseEntry(key)
        return null
      }
      const entry = leases.get(key)
      return entry?.nodeId ?? null
    },

    async shutdown(): Promise<void> {
      if (isShutdown) {
        return
      }
      isShutdown = true

      for (const entry of leases.values()) {
        clearTimeout(entry.timer)
      }
      leases.clear()
      nodes.clear()
      allocations.clear()
      partitionStates.clear()
      schemas.clear()
      kvStore.clear()
      nodeWatchers.clear()
      allocationWatchers.clear()
      schemaWatchers.clear()
    },
  }

  return coordinator
}
