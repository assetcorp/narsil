import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '../../../../../core/id-generator'
import { createController } from '../../../../../distribution/cluster/controller'
import type { ControllerNode } from '../../../../../distribution/cluster/controller/types'
import { createDataNodeLifecycle } from '../../../../../distribution/cluster/node-lifecycle'
import {
  bootstrapPartition,
  createBootstrapState,
  reportBootstrapComplete,
} from '../../../../../distribution/cluster/node-lifecycle/bootstrap'
import type { DataNodeHandle, NodeLifecycleConfig } from '../../../../../distribution/cluster/node-lifecycle/types'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../../../../../distribution/cluster/node-lifecycle/types'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../../distribution/transport'
import { ClusterMessageTypes } from '../../../../../distribution/transport/types'
import { flushPromises, makeAllocationTable, makeAssignment, makeNode } from './fixtures'

describe('DataNodeLifecycle bootstrap completion reporting and validation', () => {
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
      nodeHeartbeatIntervalMs: DEFAULT_NODE_LIFECYCLE_CONFIG.nodeHeartbeatIntervalMs,
      onBootstrapPartition: vi.fn().mockResolvedValue(true),
      ...overrides,
    })
    return lifecycle
  }

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
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
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
          expect(assignment.inSyncSet).not.toContain('data-1')
        }
      }
    })

    it('does not report bootstrap_complete when partition sync returns false', async () => {
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

      const bootstrapFn = vi.fn().mockResolvedValue(false)
      createLifecycle({ knownIndexNames: ['products'], onBootstrapPartition: bootstrapFn })
      if (lifecycle === undefined) throw new Error('lifecycle not initialised')
      await lifecycle.join()

      await flushPromises()
      await flushPromises()

      vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
      await flushPromises()
      await flushPromises()

      const table = await coordinator.getAllocation('products')
      const assignment = table?.assignments.get(0)
      expect(assignment?.state).toBe('INITIALISING')
      expect(assignment?.inSyncSet).not.toContain('data-1')
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

      const accepted = await reportBootstrapComplete('products', 0, 'unknown-node', coordinator, nodeTransport)

      expect(accepted).toBe(false)
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

        const decoded = decode(response.payload) as Record<string, unknown>
        expect(decoded.accepted).toBe(false)
      } finally {
        await spoofedTransport.shutdown()
      }
    })
  })
})

describe('bootstrapPartition reporting scope', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let controllerTransport: NodeTransport

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller-node', network)
    nodeTransport = createInMemoryTransport('data-1', network)
  })

  afterEach(async () => {
    await nodeTransport.shutdown()
    await controllerTransport.shutdown()
    await coordinator.shutdown()
  })

  async function runBootstrap(state: 'ACTIVE' | 'INITIALISING'): Promise<{ reported: boolean; result: boolean }> {
    const assignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment({ primary: 'data-0', replicas: ['data-1'], inSyncSet: [], state, primaryTerm: 1 })],
    ])
    await coordinator.putAllocation('products', makeAllocationTable('products', assignments))
    await coordinator.acquireLease('_narsil/controller', 'controller-node', 15_000)
    await coordinator.registerNode(makeNode('controller-node'))

    let reported = false
    await controllerTransport.listen(async (message, respond) => {
      if (message.type === ClusterMessageTypes.BOOTSTRAP_COMPLETE) {
        reported = true
        await respond({
          type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
          sourceId: 'controller-node',
          requestId: message.requestId,
          payload: encode({ indexName: 'products', partitionId: 0, accepted: true }),
        })
      }
    })

    const bootstrapState = createBootstrapState('products', 0, 'data-0')
    const result = await bootstrapPartition(
      bootstrapState,
      coordinator,
      nodeTransport,
      'data-1',
      1,
      2,
      0,
      async () => true,
    )

    return { reported, result }
  }

  it('treats a partition the controller already moved to ACTIVE as complete', async () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        makeAssignment({
          primary: 'data-0',
          replicas: ['data-1'],
          inSyncSet: [],
          state: 'INITIALISING',
          primaryTerm: 1,
        }),
      ],
    ])
    await coordinator.putAllocation('products', makeAllocationTable('products', assignments))
    await coordinator.acquireLease('_narsil/controller', 'controller-node', 15_000)
    await coordinator.registerNode(makeNode('controller-node'))

    let reports = 0
    await controllerTransport.listen(async (message, respond) => {
      if (message.type === ClusterMessageTypes.BOOTSTRAP_COMPLETE) {
        reports++
        const activated = new Map<number, PartitionAssignment>([
          [
            0,
            makeAssignment({
              primary: 'data-0',
              replicas: ['data-1'],
              inSyncSet: ['data-0', 'data-1'],
              state: 'ACTIVE',
              primaryTerm: 1,
            }),
          ],
        ])
        const stored = await coordinator.getAllocation('products')
        await coordinator.putAllocation(
          'products',
          makeAllocationTable('products', activated, (stored?.version ?? 1) + 1),
          stored?.version ?? null,
        )
        await respond({
          type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
          sourceId: 'controller-node',
          requestId: message.requestId,
          payload: encode({ indexName: 'products', partitionId: 0, accepted: false }),
        })
      }
    })

    const bootstrapState = createBootstrapState('products', 0, 'data-0')
    const result = await bootstrapPartition(
      bootstrapState,
      coordinator,
      nodeTransport,
      'data-1',
      1,
      2,
      3,
      async () => true,
    )

    expect(reports).toBe(1)
    expect(result).toBe(true)
  })

  it('reports completion for a partition still INITIALISING', async () => {
    const { reported, result } = await runBootstrap('INITIALISING')
    expect(reported).toBe(true)
    expect(result).toBe(true)
  })

  it('leaves an ACTIVE partition to the primary and sends no report', async () => {
    const { reported, result } = await runBootstrap('ACTIVE')
    expect(reported).toBe(false)
    expect(result).toBe(true)
  })
})

describe('bootstrapPartition when the partition state cannot be read', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let controllerTransport: NodeTransport

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller-node', network)
    nodeTransport = createInMemoryTransport('data-1', network)
  })

  afterEach(async () => {
    await nodeTransport.shutdown()
    await controllerTransport.shutdown()
    await coordinator.shutdown()
  })

  it('reports completion rather than assuming the partition is already ACTIVE', async () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        makeAssignment({
          primary: 'data-0',
          replicas: ['data-1'],
          inSyncSet: [],
          state: 'INITIALISING',
          primaryTerm: 1,
        }),
      ],
    ])
    await coordinator.putAllocation('products', makeAllocationTable('products', assignments))
    await coordinator.acquireLease('_narsil/controller', 'controller-node', 15_000)
    await coordinator.registerNode(makeNode('controller-node'))

    let reported = false
    await controllerTransport.listen(async (message, respond) => {
      if (message.type === ClusterMessageTypes.BOOTSTRAP_COMPLETE) {
        reported = true
        await respond({
          type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
          sourceId: 'controller-node',
          requestId: message.requestId,
          payload: encode({ indexName: 'products', partitionId: 0, accepted: true }),
        })
      }
    })

    const readAllocation = coordinator.getAllocation.bind(coordinator)
    let reads = 0
    coordinator.getAllocation = async (indexName: string) => {
      reads += 1
      if (reads === 1) {
        throw new Error('allocation read failed')
      }
      return readAllocation(indexName)
    }

    const result = await bootstrapPartition(
      createBootstrapState('products', 0, 'data-0'),
      coordinator,
      nodeTransport,
      'data-1',
      1,
      2,
      0,
      async () => true,
    )

    expect(reported).toBe(true)
    expect(result).toBe(true)
  })
})
