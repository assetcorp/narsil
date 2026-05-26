import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerNode } from '../../../../../distribution/cluster/controller/types'
import { createDataNodeLifecycle } from '../../../../../distribution/cluster/node-lifecycle'
import type { DataNodeHandle, NodeLifecycleConfig } from '../../../../../distribution/cluster/node-lifecycle/types'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../../../../../distribution/cluster/node-lifecycle/types'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../../distribution/transport'
import { flushPromises, makeAllocationTable, makeAssignment, makeNode } from './fixtures'

describe('DataNodeLifecycle leave, shutdown, retry, and edge cases', () => {
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

  describe('graceful leave', () => {
    it('deregisters the node on leave', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      const nodesBefore = await coordinator.listNodes()
      expect(nodesBefore.find(n => n.nodeId === 'data-1')).toBeDefined()

      await lifecycle.leave()

      const nodesAfter = await coordinator.listNodes()
      expect(nodesAfter.find(n => n.nodeId === 'data-1')).toBeUndefined()
    })

    it('transitions status to stopped after leave', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()
      expect(lifecycle.status).toBe('active')

      await lifecycle.leave()

      expect(lifecycle.status).toBe('stopped')
    })

    it('leave is a no-op when not active', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.leave()
      expect(lifecycle.status).toBe('stopped')
    })
  })

  describe('retry: bootstrap_complete with backoff', () => {
    it('retries bootstrap_complete when controller is unreachable', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      await coordinator.registerNode(makeNode('primary-node'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      createLifecycle({
        knownIndexNames: ['products'],
        onBootstrapPartition: bootstrapFn,
        bootstrapRetryBaseMs: 100,
        bootstrapMaxRetries: 2,
      })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()

      vi.advanceTimersByTime(200)
      await flushPromises()
      vi.advanceTimersByTime(400)
      await flushPromises()

      expect(bootstrapFn).toHaveBeenCalled()
    })
  })

  describe('shutdown', () => {
    it('cleans up watchers and stops retries on shutdown', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)

      createLifecycle({ onBootstrapPartition: bootstrapFn })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()
      expect(lifecycle.status).toBe('active')

      await lifecycle.shutdown()

      expect(lifecycle.status).toBe('shutdown')
    })

    it('is idempotent', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await lifecycle.shutdown()
      await lifecycle.shutdown()
      await lifecycle.shutdown()

      expect(lifecycle.status).toBe('shutdown')
    })

    it('deregisters node during shutdown when active', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      const nodesBefore = await coordinator.listNodes()
      expect(nodesBefore.find(n => n.nodeId === 'data-1')).toBeDefined()

      await lifecycle.shutdown()

      const nodesAfter = await coordinator.listNodes()
      expect(nodesAfter.find(n => n.nodeId === 'data-1')).toBeUndefined()
    })
  })

  describe('edge cases', () => {
    it('handles join with empty allocation table gracefully', async () => {
      createLifecycle({ knownIndexNames: ['products'] })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      expect(lifecycle.status).toBe('active')
    })

    it('node can rejoin after leave', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()
      expect(lifecycle.status).toBe('active')

      await lifecycle.leave()
      expect(lifecycle.status).toBe('stopped')

      await lifecycle.join()
      expect(lifecycle.status).toBe('active')
    })

    it('allocation watcher does not trigger after shutdown', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      await coordinator.registerNode(makeNode('primary-node'))

      createLifecycle({ onBootstrapPartition: bootstrapFn })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()
      await lifecycle.shutdown()

      bootstrapFn.mockClear()

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()

      expect(bootstrapFn).not.toHaveBeenCalled()
    })

    it('does not bootstrap when node is primary for the partition', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      await coordinator.registerNode(makeNode('data-1'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(
        0,
        makeAssignment({
          primary: 'data-1',
          replicas: [],
          state: 'ACTIVE',
        }),
      )
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      createLifecycle({ knownIndexNames: ['products'], onBootstrapPartition: bootstrapFn })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()

      expect(bootstrapFn).not.toHaveBeenCalled()
    })
  })
})
