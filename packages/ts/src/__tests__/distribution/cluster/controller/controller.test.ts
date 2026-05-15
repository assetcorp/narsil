import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerConfig, ControllerNode, IndexMetadata } from '../../../../distribution/cluster/controller'
import {
  CONTROLLER_LEASE_KEY,
  createController,
  getIndexMetadata,
  putIndexMetadata,
} from '../../../../distribution/cluster/controller'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type {
  AllocationConstraints,
  AllocationTable,
  ClusterCoordinator,
  NodeRegistration,
  PartitionAssignment,
} from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport, TransportMessage } from '../../../../distribution/transport'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  ReplicationMessageTypes,
} from '../../../../distribution/transport'
import type { InsyncConfirmPayload, InsyncRemovePayload } from '../../../../distribution/transport/types'
import type { SchemaDefinition } from '../../../../types/schema'

const defaultConstraints: AllocationConstraints = {
  zoneAwareness: false,
  zoneAttribute: 'zone',
  maxShardsPerNode: null,
}

const testSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
}

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

function makeIndexMetadata(indexName: string, partitionCount = 3, replicationFactor = 1): IndexMetadata {
  return {
    indexName,
    partitionCount,
    replicationFactor,
    constraints: defaultConstraints,
  }
}

function makeAllocationTable(indexName: string, nodeIds: string[], partitionCount = 3): AllocationTable {
  const assignments = new Map<number, PartitionAssignment>()
  for (let p = 0; p < partitionCount; p++) {
    const primaryIdx = p % nodeIds.length
    const replicaIdx = (p + 1) % nodeIds.length
    assignments.set(p, {
      primary: nodeIds[primaryIdx],
      replicas: primaryIdx !== replicaIdx ? [nodeIds[replicaIdx]] : [],
      inSyncSet: primaryIdx !== replicaIdx ? [nodeIds[replicaIdx]] : [],
      state: 'ACTIVE',
      primaryTerm: 1,
    })
  }
  return {
    indexName,
    version: 1,
    replicationFactor: 1,
    assignments,
  }
}

async function setupIndexWithAllocation(
  coordinator: ClusterCoordinator,
  indexName: string,
  nodeIds: string[],
  partitionCount = 3,
  replicationFactor = 1,
): Promise<void> {
  await putIndexMetadata(coordinator, makeIndexMetadata(indexName, partitionCount, replicationFactor))
  await coordinator.putAllocation(indexName, makeAllocationTable(indexName, nodeIds, partitionCount))
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>(resolve => {
      process.nextTick(resolve)
    })
  }
}

describe('Controller', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let controllerTransport: NodeTransport
  let controller: ControllerNode

  beforeEach(() => {
    vi.useFakeTimers()
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller-node', network)
  })

  afterEach(async () => {
    if (controller !== undefined) {
      await controller.shutdown()
    }
    await controllerTransport.shutdown()
    await coordinator.shutdown()
    vi.useRealTimers()
  })

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
      await controller.start()

      expect(controller.isActive).toBe(true)
      const holder = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
      expect(holder).toBe('controller-node')
    })

    it('enters standby when another node holds the lease', async () => {
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'other-node', 15_000)

      createDefaultController()
      await controller.start()

      expect(controller.isActive).toBe(false)
    })

    it('retries lease acquisition after standbyRetryMs', async () => {
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'other-node', 15_000)

      createDefaultController({ standbyRetryMs: 2_000 })
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

    it('releases the lease on stop', async () => {
      createDefaultController()
      await controller.start()
      expect(controller.isActive).toBe(true)

      await controller.stop()

      expect(controller.isActive).toBe(false)
      const holder = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
      expect(holder).toBeNull()
    })
  })

  describe('event loop: node events', () => {
    it('runs allocator for all known indexes on node_joined', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      await setupIndexWithAllocation(coordinator, 'products', ['data-1', 'data-2'])

      createDefaultController({ knownIndexNames: ['products'] })
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

  describe('insync removal', () => {
    it('handles INSYNC_REMOVE messages via transport', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      const table = makeAllocationTable('products', ['data-1', 'data-2'], 1)
      await coordinator.putAllocation('products', table)

      createDefaultController({ knownIndexNames: ['products'] })
      await controller.start()

      const primaryTransport = createInMemoryTransport('data-1', network)

      const insyncPayload: InsyncRemovePayload = {
        indexName: 'products',
        partitionId: 0,
        replicaNodeId: 'data-2',
        primaryTerm: 1,
      }

      const request: TransportMessage = {
        type: ReplicationMessageTypes.INSYNC_REMOVE,
        sourceId: 'data-1',
        requestId: 'req-insync-001',
        payload: encode(insyncPayload),
      }

      const response = await primaryTransport.send('controller-node', request)

      expect(response.type).toBe(ReplicationMessageTypes.INSYNC_CONFIRM)
      expect(response.requestId).toBe('req-insync-001')

      const confirmPayload = decode(response.payload) as InsyncConfirmPayload
      expect(confirmPayload.accepted).toBe(true)
      expect(confirmPayload.indexName).toBe('products')
      expect(confirmPayload.partitionId).toBe(0)

      const updatedTable = await coordinator.getAllocation('products')
      const assignment = updatedTable?.assignments.get(0)
      expect(assignment?.inSyncSet).not.toContain('data-2')

      await primaryTransport.shutdown()
    })

    it('rejects INSYNC_REMOVE with wrong primaryTerm', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      const table = makeAllocationTable('products', ['data-1', 'data-2'], 1)
      await coordinator.putAllocation('products', table)

      createDefaultController({ knownIndexNames: ['products'] })
      await controller.start()

      const primaryTransport = createInMemoryTransport('data-1', network)

      const insyncPayload: InsyncRemovePayload = {
        indexName: 'products',
        partitionId: 0,
        replicaNodeId: 'data-2',
        primaryTerm: 999,
      }

      const request: TransportMessage = {
        type: ReplicationMessageTypes.INSYNC_REMOVE,
        sourceId: 'data-1',
        requestId: 'req-insync-002',
        payload: encode(insyncPayload),
      }

      const response = await primaryTransport.send('controller-node', request)
      const confirmPayload = decode(response.payload) as InsyncConfirmPayload
      expect(confirmPayload.accepted).toBe(false)

      await primaryTransport.shutdown()
    })
  })

  describe('shutdown', () => {
    it('releases the lease and becomes inactive', async () => {
      createDefaultController()
      await controller.start()
      expect(controller.isActive).toBe(true)

      await controller.shutdown()

      expect(controller.isActive).toBe(false)
      const holder = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
      expect(holder).toBeNull()
    })

    it('is idempotent', async () => {
      createDefaultController()
      await controller.start()

      await controller.shutdown()
      await controller.shutdown()
      await controller.shutdown()

      expect(controller.isActive).toBe(false)
    })

    it('prevents standby retry after shutdown', async () => {
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'other-node', 15_000)

      createDefaultController({ standbyRetryMs: 1_000 })
      await controller.start()
      expect(controller.isActive).toBe(false)

      await controller.shutdown()

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)
      vi.advanceTimersByTime(2_000)
      await flushPromises()

      expect(controller.isActive).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('handles node_left for a node not in any allocation', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      await setupIndexWithAllocation(coordinator, 'products', ['data-1', 'data-2'])

      createDefaultController({ knownIndexNames: ['products'] })
      await controller.start()

      await coordinator.registerNode(makeNode('data-unknown'))
      vi.advanceTimersByTime(501)
      await flushPromises()
      await coordinator.deregisterNode('data-unknown')
      vi.advanceTimersByTime(501)
      await flushPromises()
      await flushPromises()

      const table = await coordinator.getAllocation('products')
      expect(table).not.toBeNull()
      for (const assignment of table?.assignments.values() ?? []) {
        expect(assignment.primary).not.toBeNull()
      }
    })

    it('handles no data nodes gracefully on schema_created', async () => {
      createDefaultController()
      await controller.start()
      expect(controller.isActive).toBe(true)

      await putIndexMetadata(coordinator, makeIndexMetadata('products', 2, 0))
      await coordinator.putSchema('products', testSchema)
      await flushPromises()
      await flushPromises()

      const table = await coordinator.getAllocation('products')
      expect(table).toBeNull()
    })

    it('can restart after shutdown', async () => {
      createDefaultController()
      await controller.start()
      expect(controller.isActive).toBe(true)

      await controller.shutdown()
      expect(controller.isActive).toBe(false)

      await controller.start()
      expect(controller.isActive).toBe(true)
    })
  })
})

describe('IndexMetadata', () => {
  let coordinator: ClusterCoordinator

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  it('round-trips metadata through put and get', async () => {
    const metadata: IndexMetadata = {
      indexName: 'products',
      partitionCount: 5,
      replicationFactor: 2,
      constraints: {
        zoneAwareness: true,
        zoneAttribute: 'rack',
        maxShardsPerNode: 10,
      },
    }

    const stored = await putIndexMetadata(coordinator, metadata)
    expect(stored).toBe(true)

    const retrieved = await getIndexMetadata(coordinator, 'products')
    expect(retrieved).not.toBeNull()
    expect(retrieved?.indexName).toBe('products')
    expect(retrieved?.partitionCount).toBe(5)
    expect(retrieved?.replicationFactor).toBe(2)
    expect(retrieved?.constraints.zoneAwareness).toBe(true)
    expect(retrieved?.constraints.zoneAttribute).toBe('rack')
    expect(retrieved?.constraints.maxShardsPerNode).toBe(10)
  })

  it('returns null for non-existent metadata', async () => {
    const retrieved = await getIndexMetadata(coordinator, 'nonexistent')
    expect(retrieved).toBeNull()
  })

  it('prevents overwriting existing metadata via compareAndSet', async () => {
    const metadata = {
      indexName: 'products',
      partitionCount: 3,
      replicationFactor: 1,
      constraints: defaultConstraints,
    }

    const first = await putIndexMetadata(coordinator, metadata)
    expect(first).toBe(true)

    const second = await putIndexMetadata(coordinator, { ...metadata, partitionCount: 10 })
    expect(second).toBe(false)

    const retrieved = await getIndexMetadata(coordinator, 'products')
    expect(retrieved?.partitionCount).toBe(3)
  })

  it('defaults constraint fields when they are missing from stored data', async () => {
    const metadata: IndexMetadata = {
      indexName: 'articles',
      partitionCount: 2,
      replicationFactor: 0,
      constraints: {
        zoneAwareness: false,
        zoneAttribute: 'zone',
        maxShardsPerNode: null,
      },
    }

    await putIndexMetadata(coordinator, metadata)
    const retrieved = await getIndexMetadata(coordinator, 'articles')
    expect(retrieved?.constraints.zoneAwareness).toBe(false)
    expect(retrieved?.constraints.zoneAttribute).toBe('zone')
    expect(retrieved?.constraints.maxShardsPerNode).toBeNull()
  })
})
