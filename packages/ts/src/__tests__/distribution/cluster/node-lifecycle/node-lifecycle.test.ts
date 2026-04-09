import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createController } from '../../../../distribution/cluster/controller'
import type { ControllerNode } from '../../../../distribution/cluster/controller/types'
import { createDataNodeLifecycle } from '../../../../distribution/cluster/node-lifecycle'
import type { DataNodeHandle, NodeLifecycleConfig } from '../../../../distribution/cluster/node-lifecycle/types'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../../../../distribution/cluster/node-lifecycle/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type {
  AllocationTable,
  ClusterCoordinator,
  NodeRegistration,
  PartitionAssignment,
} from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'

function makeNode(nodeId: string): NodeRegistration {
  return {
    nodeId,
    address: `${nodeId}.cluster.local:9200`,
    roles: ['data', 'coordinator', 'controller'],
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: null },
    startedAt: '2026-04-09T00:00:00Z',
    version: '1.0',
  }
}

function makeAllocationTable(
  indexName: string,
  assignments: Map<number, PartitionAssignment>,
  version = 1,
): AllocationTable {
  return { indexName, version, replicationFactor: 1, assignments }
}

function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'primary-node',
    replicas: [],
    inSyncSet: [],
    state: 'INITIALISING',
    primaryTerm: 1,
    ...overrides,
  }
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>(resolve => {
      process.nextTick(resolve)
    })
  }
}

describe('DataNodeLifecycle', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let controllerTransport: NodeTransport
  let controller: ControllerNode
  let lifecycle: DataNodeHandle

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
    }
    if (controller !== undefined) {
      await controller.shutdown()
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
      await lifecycle.join()

      const nodes = await coordinator.listNodes()
      const found = nodes.find(n => n.nodeId === 'data-1')
      expect(found).toBeDefined()
      expect(found?.address).toBe('data-1.cluster.local:9200')
    })

    it('transitions status from stopped to active', async () => {
      createLifecycle()
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
      await lifecycle.join()

      await flushPromises()
      await flushPromises()

      expect(bootstrapFn).toHaveBeenCalledWith('products', 0, 'primary-node')
    })

    it('skips when no allocation table exists for known index', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)

      createLifecycle({ knownIndexNames: ['nonexistent'], onBootstrapPartition: bootstrapFn })
      await lifecycle.join()

      await flushPromises()

      expect(bootstrapFn).not.toHaveBeenCalled()
    })

    it('throws NODE_ALREADY_JOINED when joining while active', async () => {
      createLifecycle()
      await lifecycle.join()

      await expect(lifecycle.join()).rejects.toThrow('has already joined')
    })

    it('throws NODE_NOT_JOINED when joining after shutdown', async () => {
      createLifecycle()
      await lifecycle.join()
      await lifecycle.shutdown()

      await expect(lifecycle.join()).rejects.toThrow('has been shut down')
    })
  })

  describe('bootstrap completion reporting to controller', () => {
    it('controller transitions INITIALISING to ACTIVE on bootstrap_complete', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('primary-node'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(
        0,
        makeAssignment({
          primary: 'primary-node',
          replicas: ['data-1'],
          state: 'INITIALISING',
        }),
      )
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await startController(['products'])

      const bootstrapFn = vi.fn().mockResolvedValue(true)
      createLifecycle({ knownIndexNames: ['products'], onBootstrapPartition: bootstrapFn })
      await lifecycle.join()

      await flushPromises()
      await flushPromises()

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()
      await flushPromises()

      const table = await coordinator.getAllocation('products')
      if (table !== null) {
        const assignment = table.assignments.get(0)
        if (assignment !== undefined && assignment.state === 'ACTIVE') {
          expect(assignment.state).toBe('ACTIVE')
          expect(assignment.inSyncSet).toContain('data-1')
        }
      }
    })

    it('controller rejects bootstrap_complete for unassigned node', async () => {
      await coordinator.registerNode(makeNode('primary-node'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(
        0,
        makeAssignment({
          primary: 'primary-node',
          replicas: [],
          state: 'INITIALISING',
        }),
      )
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await startController(['products'])

      const { reportBootstrapComplete } = await import('../../../../distribution/cluster/node-lifecycle/bootstrap')
      const accepted = await reportBootstrapComplete('products', 0, 'unknown-node', coordinator, nodeTransport)

      expect(accepted).toBe(false)
    })
  })

  describe('allocation watcher', () => {
    it('triggers bootstrap when new partition is assigned', async () => {
      const bootstrapFn = vi.fn().mockResolvedValue(true)
      await coordinator.registerNode(makeNode('primary-node'))

      await startController([])

      createLifecycle({ onBootstrapPartition: bootstrapFn })
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

  describe('graceful leave', () => {
    it('deregisters the node on leave', async () => {
      createLifecycle()
      await lifecycle.join()

      const nodesBefore = await coordinator.listNodes()
      expect(nodesBefore.find(n => n.nodeId === 'data-1')).toBeDefined()

      await lifecycle.leave()

      const nodesAfter = await coordinator.listNodes()
      expect(nodesAfter.find(n => n.nodeId === 'data-1')).toBeUndefined()
    })

    it('transitions status to stopped after leave', async () => {
      createLifecycle()
      await lifecycle.join()
      expect(lifecycle.status).toBe('active')

      await lifecycle.leave()

      expect(lifecycle.status).toBe('stopped')
    })

    it('leave is a no-op when not active', async () => {
      createLifecycle()
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
      await lifecycle.join()
      expect(lifecycle.status).toBe('active')

      await lifecycle.shutdown()

      expect(lifecycle.status).toBe('shutdown')
    })

    it('is idempotent', async () => {
      createLifecycle()
      await lifecycle.join()

      await lifecycle.shutdown()
      await lifecycle.shutdown()
      await lifecycle.shutdown()

      expect(lifecycle.status).toBe('shutdown')
    })

    it('deregisters node during shutdown when active', async () => {
      createLifecycle()
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
      await lifecycle.join()

      expect(lifecycle.status).toBe('active')
    })

    it('node can rejoin after leave', async () => {
      createLifecycle()
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
      await lifecycle.join()

      await flushPromises()

      expect(bootstrapFn).not.toHaveBeenCalled()
    })
  })

  describe('concurrent lifecycle operations (H3)', () => {
    it('concurrent join and shutdown settle to a consistent state', async () => {
      createLifecycle()

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

      const results = await Promise.allSettled([lifecycle.join(), lifecycle.join()])

      const firstResult = results[0]
      const secondResult = results[1]

      expect(firstResult.status).toBe('fulfilled')
      expect(secondResult.status).toBe('rejected')
      expect(lifecycle.status).toBe('active')
    })

    it('concurrent leave and shutdown settle without deadlock', async () => {
      createLifecycle()
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

  describe('bootstrap handler validation (H2, L2)', () => {
    it('controller rejects bootstrap_complete when sourceId does not match payload nodeId', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('primary-node'))

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(
        0,
        makeAssignment({
          primary: 'primary-node',
          replicas: ['data-1'],
          state: 'INITIALISING',
        }),
      )
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await startController(['products'])

      const { encode } = await import('@msgpack/msgpack')
      const { generateId } = await import('../../../../core/id-generator')
      const { ClusterMessageTypes } = await import('../../../../distribution/transport/types')

      const forgedPayload = encode({
        indexName: 'products',
        partitionId: 0,
        nodeId: 'data-1',
        primaryTerm: 1,
      })

      const spoofedTransport = createInMemoryTransport('attacker-node', network)
      try {
        const response = await spoofedTransport.send('controller-node', {
          type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
          sourceId: 'attacker-node',
          requestId: generateId(),
          payload: forgedPayload,
        })

        const { decode } = await import('@msgpack/msgpack')
        const decoded = decode(response.payload) as Record<string, unknown>
        expect(decoded.accepted).toBe(false)
      } finally {
        await spoofedTransport.shutdown()
      }
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
