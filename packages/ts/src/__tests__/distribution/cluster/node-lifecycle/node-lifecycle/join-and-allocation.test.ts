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

describe('DataNodeLifecycle join and allocation watcher', () => {
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

  describe('join', () => {
    it('registers the node with the coordinator on join', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      const nodes = await coordinator.listNodes()
      const found = nodes.find(n => n.nodeId === 'data-1')
      expect(found).toBeDefined()
      expect(found?.address).toBe('data-1.cluster.local:9200')
    })

    it('transitions status from stopped to active', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      expect(lifecycle.status).toBe('stopped')

      await lifecycle.join()

      expect(lifecycle.status).toBe('active')
    })

    it('reads initial allocation tables for known indexes', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      await coordinator.registerNode(makeNode('primary-node'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await startController(['products'])

      createLifecycle({ knownIndexNames: ['products'], onBootstrapPartition: bootstrapFn })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()
      await flushPromises()

      expect(bootstrapFn).toHaveBeenCalledWith('products', 0, 'primary-node')
    })

    it('skips when no allocation table exists for known index', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)

      createLifecycle({ knownIndexNames: ['nonexistent'], onBootstrapPartition: bootstrapFn })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()

      expect(bootstrapFn).not.toHaveBeenCalled()
    })

    it('throws NODE_ALREADY_JOINED when joining while active', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await expect(lifecycle.join()).rejects.toThrow('has already joined')
    })

    it('throws NODE_NOT_JOINED when joining after shutdown', async () => {
      createLifecycle()
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()
      await lifecycle.shutdown()

      await expect(lifecycle.join()).rejects.toThrow('has been shut down')
    })
  })

  describe('allocation watcher', () => {
    it('triggers bootstrap when new partition is assigned', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      await coordinator.registerNode(makeNode('primary-node'))

      await startController([])

      createLifecycle({ onBootstrapPartition: bootstrapFn })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()
      await flushPromises()

      expect(bootstrapFn).toHaveBeenCalledWith('products', 0, 'primary-node')
    })

    it('calls onRemovePartition when partition is removed from node', async () => {
      const removeFn = vi.fn()
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      await coordinator.registerNode(makeNode('primary-node'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(0, makeAssignment({ primary: 'primary-node', replicas: ['data-1'] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await startController(['products'])

      createLifecycle({
        knownIndexNames: ['products'],
        onBootstrapPartition: bootstrapFn,
        onRemovePartition: removeFn,
      })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()

      const updatedAssignments = new Map<number, PartitionAssignment>()
      updatedAssignments.set(0, makeAssignment({ primary: 'primary-node', replicas: [] }))
      await coordinator.putAllocation('products', makeAllocationTable('products', updatedAssignments, 2))

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()
      await flushPromises()

      expect(removeFn).toHaveBeenCalledWith('products', 0)
    })

    it('triggers demotion and re-sync on zombie primary detection', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      const demotionFn = vi.fn()
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(
        0,
        makeAssignment({
          primary: 'data-1',
          replicas: ['data-2'],
          inSyncSet: ['data-2'],
          state: 'ACTIVE',
          primaryTerm: 1,
        }),
      )
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await startController(['products'])

      createLifecycle({
        knownIndexNames: ['products'],
        onBootstrapPartition: bootstrapFn,
        onPrimaryDemotion: demotionFn,
      })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()

      const demotedAssignments = new Map<number, PartitionAssignment>()
      demotedAssignments.set(
        0,
        makeAssignment({
          primary: 'data-2',
          replicas: ['data-1'],
          inSyncSet: ['data-1'],
          state: 'ACTIVE',
          primaryTerm: 2,
        }),
      )
      await coordinator.putAllocation('products', makeAllocationTable('products', demotedAssignments, 2))

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()
      await flushPromises()

      expect(demotionFn).toHaveBeenCalledWith('products', 0, 'data-2')
      expect(bootstrapFn).toHaveBeenCalledWith('products', 0, 'data-2')
    })
  })
})
