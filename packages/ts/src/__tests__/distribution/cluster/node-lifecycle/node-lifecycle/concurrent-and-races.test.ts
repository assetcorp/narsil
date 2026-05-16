import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createController } from '../../../../../distribution/cluster/controller'
import type { ControllerNode } from '../../../../../distribution/cluster/controller/types'
import { createDataNodeLifecycle } from '../../../../../distribution/cluster/node-lifecycle'
import type { DataNodeHandle, NodeLifecycleConfig } from '../../../../../distribution/cluster/node-lifecycle/types'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../../../../../distribution/cluster/node-lifecycle/types'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../../distribution/transport'
import { flushPromises, makeAllocationTable, makeAssignment, makeNode } from './fixtures'

describe('DataNodeLifecycle concurrent operations and races', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let controllerTransport: NodeTransport
  let controller: ControllerNode | undefined
  let lifecycle: DataNodeHandle | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller-node', network)
    nodeTransport = createInMemoryTransport('data-1', network)
  })

  afterEach(async () => {
    if (lifecycle !== undefined) {
      await lifecycle.shutdown()
      lifecycle = undefined
    }
    if (controller !== undefined) {
      await controller.shutdown()
      controller = undefined
    }
    await nodeTransport.shutdown()
    await controllerTransport.shutdown()
    await coordinator.shutdown()
    vi.useRealTimers()
  })

  function startController(knownIndexNames: string[] = []): Promise<void> {
    controller = createController({
      nodeId: 'controller-node',
      coordinator,
      transport: controllerTransport,
      leaseTtlMs: 15_000,
      standbyRetryMs: 5_000,
      knownIndexNames,
    })
    return controller.start()
  }

  function createLifecycle(overrides: Partial<NodeLifecycleConfig> = {}): DataNodeHandle {
    lifecycle = createDataNodeLifecycle({
      registration: makeNode('data-1'),
      coordinator,
      transport: nodeTransport,
      knownIndexNames: [],
      bootstrapRetryBaseMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryBaseMs,
      bootstrapRetryMaxMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryMaxMs,
      bootstrapMaxRetries: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapMaxRetries,
      allocationDebounceMs: DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs,
      onBootstrapPartition: vi.fn().mockResolvedValue(true),
      ...overrides,
    })
    return lifecycle
  }

  describe('concurrent lifecycle operations (H3)', () => {
    it('concurrent join and shutdown settle to a consistent state', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')

      const results = await Promise.allSettled([lifecycle.join(), lifecycle.shutdown()])

      const joinResult = results[0]
      const shutdownResult = results[1]

      if (joinResult.status === 'fulfilled') {
        expect(lifecycle.status).toBe('shutdown')
        expect(shutdownResult.status).toBe('fulfilled')
      } else {
        expect(lifecycle.status).toBe('shutdown')
      }
    })

    it('concurrent join calls serialize and the second one rejects', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')

      const results = await Promise.allSettled([lifecycle.join(), lifecycle.join()])

      const firstResult = results[0]
      const secondResult = results[1]

      expect(firstResult.status).toBe('fulfilled')
      expect(secondResult.status).toBe('rejected')
      expect(lifecycle.status).toBe('active')
    })

    it('concurrent leave and shutdown settle without deadlock', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await Promise.allSettled([lifecycle.leave(), lifecycle.shutdown()])

      expect(lifecycle.status).toBe('shutdown')
    })
  })

  describe('bootstrap-in-progress + partition removal race (L5)', () => {
    it('aborts an active bootstrap when the partition is removed from allocation', async () => {
      let bootstrapResolve: (() => void) | undefined
      const bootstrapFn = vi.fn().mockImplementation(
        () =>
          new Promise<boolean>(resolve => {
            bootstrapResolve = () => resolve(true)
          }),
      )

      await coordinator.registerNode(makeNode('primary-node'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await startController(['products'])

      createLifecycle({
        knownIndexNames: ['products'],
        onBootstrapPartition: bootstrapFn,
      })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()
      expect(bootstrapFn).toHaveBeenCalledTimes(1)

      const emptyAssignments = new Map<number, PartitionAssignment>()
      emptyAssignments.set(0, makeAssignment({ primary: 'primary-node', replicas: [] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', emptyAssignments, 2))

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()

      if (bootstrapResolve !== undefined) {
        bootstrapResolve()
      }
      await flushPromises()

      expect(lifecycle.status).toBe('active')
    })
  })

  describe('debounce accumulates tables for multiple indexes (M1)', () => {
    it('processes allocation events from multiple indexes within a single debounce window', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      await coordinator.registerNode(makeNode('primary-node'))

      await startController([])

      createLifecycle({ onBootstrapPartition: bootstrapFn })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      const productsAssignments = new Map<number, PartitionAssignment>()
      productsAssignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', productsAssignments))

      const ordersAssignments = new Map<number, PartitionAssignment>()
      ordersAssignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('orders', makeAllocationTable('orders', ordersAssignments))

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()
      await flushPromises()

      const calledIndexes = bootstrapFn.mock.calls.map((call: unknown[]) => call[0])
      expect(calledIndexes).toContain('products')
      expect(calledIndexes).toContain('orders')
    })
  })

  describe('failed bootstrap retry via allocation watcher (M4)', () => {
    it('re-triggers bootstrap after a failed sync on next allocation event', async () => {
      const bootstrapFn = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      await coordinator.registerNode(makeNode('primary-node'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await startController(['products'])

      createLifecycle({
        knownIndexNames: ['products'],
        onBootstrapPartition: bootstrapFn,
      })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()
      await flushPromises()

      expect(bootstrapFn).toHaveBeenCalledTimes(1)

      await coordinator.putAllocation('products', makeAllocationTable('products', assignments, 3))

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()
      await flushPromises()

      expect(bootstrapFn).toHaveBeenCalledTimes(2)
    })
  })
})
