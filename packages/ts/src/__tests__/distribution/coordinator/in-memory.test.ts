import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AllocationEvent,
  AllocationTable,
  ClusterCoordinator,
  NodeEvent,
  NodeRegistration,
  PartitionAssignment,
  SchemaEvent,
} from '../../../distribution/coordinator'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { SchemaDefinition } from '../../../types/schema'

function makeNodeRegistration(overrides: Partial<NodeRegistration> = {}): NodeRegistration {
  return {
    nodeId: 'node-1',
    address: '127.0.0.1:9200',
    roles: ['data', 'coordinator', 'controller'],
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: 100_000_000_000 },
    startedAt: '2026-04-08T10:00:00Z',
    version: '1.0',
    ...overrides,
  }
}

function makeAllocationTable(indexName: string): AllocationTable {
  const assignment: PartitionAssignment = {
    primary: 'node-1',
    replicas: ['node-2'],
    inSyncSet: ['node-2'],
    state: 'ACTIVE',
    primaryTerm: 1,
  }
  return {
    indexName,
    version: 1,
    replicationFactor: 1,
    assignments: new Map([[0, assignment]]),
  }
}

const testSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  published: 'boolean',
}

describe('InMemoryCoordinator', () => {
  let coordinator: ClusterCoordinator

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  describe('node registration', () => {
    it('registers a node and lists it', async () => {
      const reg = makeNodeRegistration()
      await coordinator.registerNode(reg)

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(1)
      expect(listed[0].nodeId).toBe('node-1')
      expect(listed[0].address).toBe('127.0.0.1:9200')
    })

    it('registers multiple nodes', async () => {
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-1' }))
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-2', address: '127.0.0.1:9201' }))

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(2)
      const ids = listed.map(n => n.nodeId).sort()
      expect(ids).toEqual(['node-1', 'node-2'])
    })

    it('re-registers a node with the same nodeId (updates registration)', async () => {
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-1', address: '127.0.0.1:9200' }))
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-1', address: '127.0.0.1:9999' }))

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(1)
      expect(listed[0].address).toBe('127.0.0.1:9999')
    })

    it('deregisters a node and removes it from the list', async () => {
      await coordinator.registerNode(makeNodeRegistration())
      await coordinator.deregisterNode('node-1')

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(0)
    })

    it('deregistering a non-existent node does not throw', async () => {
      await expect(coordinator.deregisterNode('non-existent')).resolves.toBeUndefined()
    })
  })

  describe('node watchers', () => {
    it('fires node_joined on registration', async () => {
      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      const reg = makeNodeRegistration()
      await coordinator.registerNode(reg)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('node_joined')
      expect(events[0].nodeId).toBe('node-1')
      expect(events[0].registration).toEqual(reg)
    })

    it('fires node_left on deregistration', async () => {
      await coordinator.registerNode(makeNodeRegistration())

      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      await coordinator.deregisterNode('node-1')

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('node_left')
      expect(events[0].nodeId).toBe('node-1')
      expect(events[0].registration).toBeNull()
    })

    it('does not fire node_left when deregistering a non-existent node', async () => {
      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      await coordinator.deregisterNode('ghost-node')

      expect(events).toHaveLength(0)
    })
  })

  describe('leases', () => {
    it('acquires a lease when no one holds it', async () => {
      const acquired = await coordinator.acquireLease('test-key', 'node-1', 10_000)
      expect(acquired).toBe(true)
    })

    it('fails to acquire a lease held by another node', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const acquired = await coordinator.acquireLease('test-key', 'node-2', 10_000)
      expect(acquired).toBe(false)
    })

    it('allows the same node to re-acquire its own lease', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const acquired = await coordinator.acquireLease('test-key', 'node-1', 10_000)
      expect(acquired).toBe(true)
    })

    it('renews a lease for the holder', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const renewed = await coordinator.renewLease('test-key', 'node-1', 10_000)
      expect(renewed).toBe(true)
    })

    it('fails to renew a lease for a non-holder', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const renewed = await coordinator.renewLease('test-key', 'node-2', 10_000)
      expect(renewed).toBe(false)
    })

    it('fails to renew a lease that does not exist', async () => {
      const renewed = await coordinator.renewLease('no-such-key', 'node-1', 10_000)
      expect(renewed).toBe(false)
    })

    it('releases a lease and allows re-acquisition', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      await coordinator.releaseLease('test-key')

      const acquired = await coordinator.acquireLease('test-key', 'node-2', 10_000)
      expect(acquired).toBe(true)
    })

    it('releasing a non-existent lease does not throw', async () => {
      await expect(coordinator.releaseLease('no-such-key')).resolves.toBeUndefined()
    })

    it('getLeaseHolder returns the holder nodeId', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const holder = await coordinator.getLeaseHolder('test-key')
      expect(holder).toBe('node-1')
    })

    it('getLeaseHolder returns null when no lease exists', async () => {
      const holder = await coordinator.getLeaseHolder('test-key')
      expect(holder).toBeNull()
    })

    it('getLeaseHolder returns null after lease is released', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      await coordinator.releaseLease('test-key')
      const holder = await coordinator.getLeaseHolder('test-key')
      expect(holder).toBeNull()
    })
  })

  describe('lease expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('expires a lease after the TTL and allows re-acquisition', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 5_000)

      vi.advanceTimersByTime(5_001)

      const acquired = await coordinator.acquireLease('test-key', 'node-2', 10_000)
      expect(acquired).toBe(true)
    })

    it('fires node_left when a node heartbeat lease expires', async () => {
      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-expiring' }))
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('node_joined')

      vi.advanceTimersByTime(30_001)

      expect(events).toHaveLength(2)
      expect(events[1].type).toBe('node_left')
      expect(events[1].nodeId).toBe('node-expiring')
      expect(events[1].registration).toBeNull()

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(0)
    })

    it('renewing a lease prevents expiry', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 5_000)

      vi.advanceTimersByTime(3_000)
      await coordinator.renewLease('test-key', 'node-1', 5_000)

      vi.advanceTimersByTime(3_000)
      const holder = await coordinator.getLeaseHolder('test-key')
      expect(holder).toBe('node-1')
    })

    it('fails to renew an expired lease', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 5_000)

      vi.advanceTimersByTime(5_001)

      const renewed = await coordinator.renewLease('test-key', 'node-1', 5_000)
      expect(renewed).toBe(false)
    })
  })

  describe('compareAndSet', () => {
    it('succeeds with null expected on a new key', async () => {
      const value = new Uint8Array([1, 2, 3])
      const result = await coordinator.compareAndSet('cas-key', null, value)
      expect(result).toBe(true)
    })

    it('fails with null expected on an existing key', async () => {
      const value = new Uint8Array([1, 2, 3])
      await coordinator.compareAndSet('cas-key', null, value)

      const result = await coordinator.compareAndSet('cas-key', null, new Uint8Array([4, 5, 6]))
      expect(result).toBe(false)
    })

    it('succeeds when expected matches the current value', async () => {
      const original = new Uint8Array([1, 2, 3])
      await coordinator.compareAndSet('cas-key', null, original)

      const updated = new Uint8Array([4, 5, 6])
      const result = await coordinator.compareAndSet('cas-key', original, updated)
      expect(result).toBe(true)
    })

    it('fails when expected does not match the current value', async () => {
      const original = new Uint8Array([1, 2, 3])
      await coordinator.compareAndSet('cas-key', null, original)

      const wrong = new Uint8Array([9, 9, 9])
      const updated = new Uint8Array([4, 5, 6])
      const result = await coordinator.compareAndSet('cas-key', wrong, updated)
      expect(result).toBe(false)
    })

    it('fails when expected is non-null but key does not exist', async () => {
      const expected = new Uint8Array([1, 2, 3])
      const value = new Uint8Array([4, 5, 6])
      const result = await coordinator.compareAndSet('missing-key', expected, value)
      expect(result).toBe(false)
    })

    it('stores a defensive copy of the value', async () => {
      const value = new Uint8Array([1, 2, 3])
      await coordinator.compareAndSet('cas-key', null, value)

      value[0] = 99

      const check = new Uint8Array([1, 2, 3])
      const updated = new Uint8Array([10, 20, 30])
      const result = await coordinator.compareAndSet('cas-key', check, updated)
      expect(result).toBe(true)
    })
  })

  describe('allocation table', () => {
    it('returns null for a non-existent allocation', async () => {
      const result = await coordinator.getAllocation('no-such-index')
      expect(result).toBeNull()
    })

    it('round-trips an allocation table', async () => {
      const table = makeAllocationTable('products')
      await coordinator.putAllocation('products', table)

      const retrieved = await coordinator.getAllocation('products')
      expect(retrieved).not.toBeNull()
      expect(retrieved?.indexName).toBe('products')
      expect(retrieved?.version).toBe(1)
      expect(retrieved?.replicationFactor).toBe(1)
      expect(retrieved?.assignments.get(0)?.primary).toBe('node-1')
    })

    it('fires watchers on putAllocation', async () => {
      const events: AllocationEvent[] = []
      await coordinator.watchAllocation(event => events.push(event))

      const table = makeAllocationTable('products')
      await coordinator.putAllocation('products', table)

      expect(events).toHaveLength(1)
      expect(events[0].indexName).toBe('products')
      expect(events[0].table).toBe(table)
    })

    it('overwrites an existing allocation table', async () => {
      await coordinator.putAllocation('products', makeAllocationTable('products'))

      const updatedTable = makeAllocationTable('products')
      updatedTable.version = 2
      await coordinator.putAllocation('products', updatedTable)

      const retrieved = await coordinator.getAllocation('products')
      expect(retrieved?.version).toBe(2)
    })
  })

  describe('partition state', () => {
    it('returns UNASSIGNED for a non-existent partition', async () => {
      const state = await coordinator.getPartitionState('products', 0)
      expect(state).toBe('UNASSIGNED')
    })

    it('round-trips a partition state', async () => {
      await coordinator.putPartitionState('products', 0, 'ACTIVE')
      const state = await coordinator.getPartitionState('products', 0)
      expect(state).toBe('ACTIVE')
    })

    it('stores partition states independently per index and partition', async () => {
      await coordinator.putPartitionState('products', 0, 'ACTIVE')
      await coordinator.putPartitionState('products', 1, 'INITIALISING')
      await coordinator.putPartitionState('articles', 0, 'MIGRATING')

      expect(await coordinator.getPartitionState('products', 0)).toBe('ACTIVE')
      expect(await coordinator.getPartitionState('products', 1)).toBe('INITIALISING')
      expect(await coordinator.getPartitionState('articles', 0)).toBe('MIGRATING')
      expect(await coordinator.getPartitionState('articles', 1)).toBe('UNASSIGNED')
    })
  })

  describe('schemas', () => {
    it('returns null for a non-existent schema', async () => {
      const schema = await coordinator.getSchema('no-such-index')
      expect(schema).toBeNull()
    })

    it('round-trips a schema', async () => {
      await coordinator.putSchema('articles', testSchema)
      const retrieved = await coordinator.getSchema('articles')
      expect(retrieved).toEqual(testSchema)
    })

    it('fires watchers on putSchema', async () => {
      const events: SchemaEvent[] = []
      await coordinator.watchSchemas(event => events.push(event))

      await coordinator.putSchema('articles', testSchema)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('schema_created')
      expect(events[0].indexName).toBe('articles')
      expect(events[0].schema).toEqual(testSchema)
    })

    it('overwrites an existing schema', async () => {
      await coordinator.putSchema('articles', testSchema)

      const updatedSchema: SchemaDefinition = { title: 'string', tags: 'string[]' }
      await coordinator.putSchema('articles', updatedSchema)

      const retrieved = await coordinator.getSchema('articles')
      expect(retrieved).toEqual(updatedSchema)
    })
  })

  describe('shutdown', () => {
    it('rejects operations after shutdown', async () => {
      await coordinator.registerNode(makeNodeRegistration())
      await coordinator.putAllocation('products', makeAllocationTable('products'))
      await coordinator.putSchema('products', testSchema)

      await coordinator.shutdown()

      await expect(coordinator.listNodes()).rejects.toThrow('Coordinator has been shut down')
      await expect(coordinator.getAllocation('products')).rejects.toThrow('Coordinator has been shut down')
      await expect(coordinator.getSchema('products')).rejects.toThrow('Coordinator has been shut down')
      await expect(coordinator.getLeaseHolder('test-key')).rejects.toThrow('Coordinator has been shut down')
      await expect(coordinator.registerNode(makeNodeRegistration())).rejects.toThrow('Coordinator has been shut down')
    })

    it('is idempotent', async () => {
      await coordinator.shutdown()
      await expect(coordinator.shutdown()).resolves.toBeUndefined()
    })

    it('clears watchers so they do not fire after shutdown', async () => {
      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      await coordinator.shutdown()

      coordinator = createInMemoryCoordinator()
      await coordinator.registerNode(makeNodeRegistration())

      expect(events).toHaveLength(0)
    })
  })
})
