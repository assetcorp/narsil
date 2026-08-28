import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerConfig, ControllerNode } from '../../../../../distribution/cluster/controller'
import {
  CONTROLLER_LEASE_KEY,
  createController,
  putIndexMetadata,
} from '../../../../../distribution/cluster/controller'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../../distribution/transport'
import { flushPromises, makeIndexMetadata, makeNode, setupIndexWithAllocation, testSchema } from './fixtures'

describe('Controller election and event loop', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let controllerTransport: NodeTransport
  let controller: ControllerNode | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller-node', network)
  })

  afterEach(async () => {
    if (controller !== undefined) {
      await controller.shutdown()
      controller = undefined
    }
    await controllerTransport.shutdown()
    await coordinator.shutdown()
    vi.useRealTimers()
  })

  function refusingCoordinator(refusals: { count: number }): ClusterCoordinator {
    return {
      ...coordinator,
      acquireLease: async (key: string, leaseNodeId: string, ttlMs: number): Promise<boolean> => {
        if (refusals.count > 0) {
          refusals.count--
          throw new Error('the coordinator is unreachable')
        }
        return coordinator.acquireLease(key, leaseNodeId, ttlMs)
      },
    }
  }

  function createDefaultController(overrides: Partial<ControllerConfig> = {}): ControllerNode {
    controller = createController({
      nodeId: 'controller-node',
      coordinator,
      transport: controllerTransport,
      leaseTtlMs: 15_000,
      standbyRetryMs: 5_000,
      knownIndexNames: [],
      ...overrides,
    })
    return controller
  }

  describe('election', () => {
    it('acquires the controller lease on start', async () => {
      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      expect(controller.isActive).toBe(true)
      const holder = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
      expect(holder).toBe('controller-node')
    })

    it('enters standby when another node holds the lease', async () => {
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'other-node', 15_000)

      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      expect(controller.isActive).toBe(false)
    })

    it('retries lease acquisition after standbyRetryMs', async () => {
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'other-node', 15_000)

      createDefaultController({ standbyRetryMs: 2_000 })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(false)

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)

      vi.advanceTimersByTime(2_001)
      await flushPromises()
      await flushPromises()

      expect(controller.isActive).toBe(true)
    })

    it('renews the lease periodically at ttlMs / 3 interval', async () => {
      createDefaultController({ leaseTtlMs: 9_000 })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(true)

      vi.advanceTimersByTime(3_001)
      await flushPromises()

      const holder = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
      expect(holder).toBe('controller-node')
      expect(controller.isActive).toBe(true)
    })

    it('steps down when lease renewal fails', async () => {
      createDefaultController({ leaseTtlMs: 9_000 })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(true)

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'usurper-node', 15_000)

      vi.advanceTimersByTime(3_001)
      await flushPromises()
      await flushPromises()

      expect(controller.isActive).toBe(false)
    })

    it('re-acquires the lease after stepping down', async () => {
      createDefaultController({ leaseTtlMs: 9_000, standbyRetryMs: 2_000 })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(true)

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'usurper-node', 9_000)

      vi.advanceTimersByTime(3_001)
      await flushPromises()
      await flushPromises()
      expect(controller.isActive).toBe(false)

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)

      vi.advanceTimersByTime(2_001)
      await flushPromises()
      await flushPromises()

      expect(controller.isActive).toBe(true)
    })

    it('stands for election again after the coordinator refuses the attempt at startup', async () => {
      const refusals = { count: 1 }
      createDefaultController({ coordinator: refusingCoordinator(refusals), standbyRetryMs: 2_000 })
      if (controller === undefined) throw new Error('controller not initialised')

      await expect(controller.start()).rejects.toThrow('the coordinator is unreachable')
      expect(controller.isActive).toBe(false)

      vi.advanceTimersByTime(2_001)
      await flushPromises()
      await flushPromises()

      expect(controller.isActive).toBe(true)
    })

    it('reports a refused attempt to onElectionError and stands for election again', async () => {
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'other-node', 15_000)
      const refusals = { count: 0 }
      const reported: unknown[] = []
      createDefaultController({
        coordinator: refusingCoordinator(refusals),
        standbyRetryMs: 2_000,
        onElectionError: error => {
          reported.push(error)
        },
      })
      if (controller === undefined) throw new Error('controller not initialised')

      await controller.start()
      expect(controller.isActive).toBe(false)

      refusals.count = 1
      vi.advanceTimersByTime(2_001)
      await flushPromises()
      await flushPromises()

      expect(reported).toHaveLength(1)
      expect(controller.isActive).toBe(false)

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)
      vi.advanceTimersByTime(2_001)
      await flushPromises()
      await flushPromises()

      expect(controller.isActive).toBe(true)
    })

    it('keeps standing for election after stepping down into a refused attempt', async () => {
      const refusals = { count: 0 }
      createDefaultController({
        coordinator: refusingCoordinator(refusals),
        leaseTtlMs: 9_000,
        standbyRetryMs: 2_000,
      })
      if (controller === undefined) throw new Error('controller not initialised')

      await controller.start()
      expect(controller.isActive).toBe(true)

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'usurper-node', 9_000)
      refusals.count = 1

      vi.advanceTimersByTime(3_001)
      await flushPromises()
      await flushPromises()
      expect(controller.isActive).toBe(false)

      vi.advanceTimersByTime(2_001)
      await flushPromises()
      await flushPromises()
      expect(controller.isActive).toBe(false)

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)

      vi.advanceTimersByTime(2_001)
      await flushPromises()
      await flushPromises()

      expect(controller.isActive).toBe(true)
    })

    it('releases the lease on stop', async () => {
      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(true)

      await controller.stop()

      expect(controller.isActive).toBe(false)
      const holder = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
      expect(holder).toBeNull()
    })
  })

  describe('election seeding', () => {
    it('seeds known indexes from the coordinator schema listing at election', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))
      await coordinator.putSchema('products', testSchema)
      await setupIndexWithAllocation(coordinator, 'products', ['data-1'])

      const tableBefore = await coordinator.getAllocation('products')
      const versionBefore = tableBefore?.version ?? 0

      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      vi.advanceTimersByTime(501)
      await flushPromises()
      await flushPromises()

      const tableAfter = await coordinator.getAllocation('products')
      expect(tableAfter).not.toBeNull()
      expect(tableAfter?.version).toBeGreaterThan(versionBefore)
    })
  })

  describe('event loop: node events', () => {
    it('runs allocator for all known indexes on node_joined', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      await setupIndexWithAllocation(coordinator, 'products', ['data-1', 'data-2'])

      createDefaultController({ knownIndexNames: ['products'] })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      const tableBefore = await coordinator.getAllocation('products')
      const versionBefore = tableBefore?.version ?? 0

      await coordinator.registerNode(makeNode('data-3'))
      vi.advanceTimersByTime(501)
      await flushPromises()
      await flushPromises()

      const tableAfter = await coordinator.getAllocation('products')
      expect(tableAfter).not.toBeNull()
      expect(tableAfter?.version).toBeGreaterThan(versionBefore)
    })

    it('runs allocator for all known indexes on node_left', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))
      await coordinator.registerNode(makeNode('data-3'))

      await setupIndexWithAllocation(coordinator, 'products', ['data-1', 'data-2', 'data-3'])

      createDefaultController({ knownIndexNames: ['products'] })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      const tableBefore = await coordinator.getAllocation('products')
      const versionBefore = tableBefore?.version ?? 0

      await coordinator.deregisterNode('data-3')
      vi.advanceTimersByTime(501)
      await flushPromises()
      await flushPromises()

      const tableAfter = await coordinator.getAllocation('products')
      expect(tableAfter).not.toBeNull()
      expect(tableAfter?.version).toBeGreaterThan(versionBefore)
    })

    it('handles multiple indexes on topology change', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      await setupIndexWithAllocation(coordinator, 'products', ['data-1', 'data-2'])
      await setupIndexWithAllocation(coordinator, 'articles', ['data-1', 'data-2'])

      createDefaultController({ knownIndexNames: ['products', 'articles'] })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      await coordinator.registerNode(makeNode('data-3'))
      vi.advanceTimersByTime(501)
      await flushPromises()
      await flushPromises()

      const productsTable = await coordinator.getAllocation('products')
      const articlesTable = await coordinator.getAllocation('articles')
      expect(productsTable?.version).toBeGreaterThan(1)
      expect(articlesTable?.version).toBeGreaterThan(1)
    })
  })

  describe('event loop: schema events', () => {
    it('runs allocator on schema_created with metadata', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      await putIndexMetadata(coordinator, makeIndexMetadata('products', 3, 1))
      await coordinator.putSchema('products', testSchema)
      await flushPromises()
      await flushPromises()

      const table = await coordinator.getAllocation('products')
      expect(table).not.toBeNull()
      expect(table?.indexName).toBe('products')
      expect(table?.assignments.size).toBe(3)
    })

    it('tracks new indexes from schema_created for future node events', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      await putIndexMetadata(coordinator, makeIndexMetadata('products', 2, 1))
      await coordinator.putSchema('products', testSchema)
      await flushPromises()
      await flushPromises()

      const tableV1 = await coordinator.getAllocation('products')
      expect(tableV1).not.toBeNull()
      const versionAfterCreate = tableV1?.version ?? 0

      await coordinator.registerNode(makeNode('data-3'))
      vi.advanceTimersByTime(501)
      await flushPromises()
      await flushPromises()

      const tableV2 = await coordinator.getAllocation('products')
      expect(tableV2?.version).toBeGreaterThan(versionAfterCreate)
    })

    it('skips allocation when metadata is missing for new schema', async () => {
      await coordinator.registerNode(makeNode('data-1'))

      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      await coordinator.putSchema('orphan-index', testSchema)
      await flushPromises()
      await flushPromises()

      const table = await coordinator.getAllocation('orphan-index')
      expect(table).toBeNull()
    })

    it('handles rapid schema events without errors', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      for (let i = 0; i < 5; i++) {
        const name = `index-${i}`
        await putIndexMetadata(coordinator, makeIndexMetadata(name, 2, 0))
        await coordinator.putSchema(name, testSchema)
        await flushPromises()
      }
      await flushPromises()

      for (let i = 0; i < 5; i++) {
        const table = await coordinator.getAllocation(`index-${i}`)
        expect(table).not.toBeNull()
        expect(table?.assignments.size).toBe(2)
      }
    })
  })
})
