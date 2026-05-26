import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationEvent, ClusterCoordinator, NodeEvent, SchemaEvent } from '../../../../distribution/coordinator'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { SchemaDefinition } from '../../../../types/schema'
import { makeAllocationTable, makeNodeRegistration, testSchema } from './fixtures'

describe('InMemoryCoordinator', () => {
  let coordinator: ClusterCoordinator

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
  })

  afterEach(async () => {
    await coordinator.shutdown()
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
