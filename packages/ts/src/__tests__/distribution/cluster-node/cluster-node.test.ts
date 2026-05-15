import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode, ClusterNodeConfig } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'

function makeConfig(
  overrides: Partial<ClusterNodeConfig> & {
    coordinator: ClusterCoordinator
    transport: NodeTransport
    address: string
  },
): ClusterNodeConfig {
  return {
    roles: ['data', 'coordinator', 'controller'],
    ...overrides,
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
    primary: null,
    replicas: [],
    inSyncSet: [],
    state: 'UNASSIGNED',
    primaryTerm: 1,
    ...overrides,
  }
}

describe('createClusterNode', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport

  beforeEach(() => {
    vi.useFakeTimers()
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network)
    transportB = createInMemoryTransport('node-b', network)
  })

  afterEach(async () => {
    if (nodeA !== undefined) {
      await nodeA.shutdown()
      nodeA = undefined
    }
    if (nodeB !== undefined) {
      await nodeB.shutdown()
      nodeB = undefined
    }
    await transportA.shutdown()
    await transportB.shutdown()
    await coordinator.shutdown()
    vi.useRealTimers()
  })

  describe('node creation and configuration', () => {
    it('creates a node with explicit nodeId', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'explicit-id',
        }),
      )

      expect(nodeA.nodeId).toBe('explicit-id')
    })

    it('auto-generates nodeId when not provided', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
        }),
      )

      expect(nodeA.nodeId).toBeTruthy()
      expect(nodeA.nodeId.length).toBeGreaterThan(0)
    })

    it('defaults to all three roles when roles not specified', async () => {
      nodeA = await createClusterNode({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
      })

      expect(nodeA.roles).toEqual(['data', 'coordinator', 'controller'])
    })

    it('respects custom roles', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          roles: ['data'],
        }),
      )

      expect(nodeA.roles).toEqual(['data'])
    })

    it('rejects empty address', async () => {
      await expect(
        createClusterNode(
          makeConfig({
            coordinator,
            transport: transportA,
            address: '',
          }),
        ),
      ).rejects.toThrow('address must not be empty')
    })

    it('rejects empty roles array', async () => {
      await expect(
        createClusterNode(
          makeConfig({
            coordinator,
            transport: transportA,
            address: 'node-a:9200',
            roles: [],
          }),
        ),
      ).rejects.toThrow('at least one role')
    })

    it('rejects invalid capacity values', async () => {
      await expect(
        createClusterNode(
          makeConfig({
            coordinator,
            transport: transportA,
            address: 'node-a:9200',
            capacity: { memoryBytes: -1, cpuCores: 4, diskBytes: null },
          }),
        ),
      ).rejects.toThrow('memoryBytes')
    })
  })

  describe('start and cluster joining', () => {
    it('joins the cluster on start and registers with coordinator', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      const nodes = await coordinator.listNodes()
      const found = nodes.find(n => n.nodeId === 'node-a')
      expect(found).toBeDefined()
      expect(found?.address).toBe('node-a:9200')
    })

    it('coordinator-only node starts without lifecycle join', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['coordinator'],
        }),
      )

      await nodeA.start()

      const info = nodeA.cluster.getNodeInfo()
      expect(info.status).toBe('stopped')
    })
  })

  describe('controller role', () => {
    it('controller becomes active when node has controller role', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'controller'],
        }),
      )

      await nodeA.start()

      expect(nodeA.cluster.isControllerActive()).toBe(true)
    })

    it('node without controller role reports controller inactive', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data'],
        }),
      )

      await nodeA.start()

      expect(nodeA.cluster.isControllerActive()).toBe(false)
    })
  })

  describe('createIndex', () => {
    it('writes index metadata and schema to coordinator', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await nodeA.createIndex('products', {
        schema: { title: 'string', price: 'number' },
      })

      const schema = await coordinator.getSchema('products')
      expect(schema).toEqual({ title: 'string', price: 'number' })

      const rawMeta = await coordinator.get('_narsil/index/products/config')
      expect(rawMeta).not.toBeNull()
    })

    it('rejects duplicate index creation', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await nodeA.createIndex('products', {
        schema: { title: 'string' },
      })

      await expect(nodeA.createIndex('products', { schema: { title: 'string' } })).rejects.toThrow('already exists')
    })

    it('schema appears on coordinator after createIndex on another node', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data', 'coordinator'],
        }),
      )

      await nodeA.start()
      await nodeB.start()

      await nodeA.createIndex('products', {
        schema: { title: 'string', price: 'number' },
      })

      const schemaFromCoordinator = await coordinator.getSchema('products')
      expect(schemaFromCoordinator).toEqual({ title: 'string', price: 'number' })
    })
  })

  describe('insert and query on single node', () => {
    it('inserts a document and queries it back', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', {
        schema: { title: 'string', price: 'number' },
      })

      const docId = await nodeA.insert('products', { title: 'Widget', price: 9.99 })
      expect(docId).toBeTruthy()

      const result = await nodeA.query('products', { term: 'Widget' })
      expect(result.count).toBe(1)
      expect(result.hits[0].document).toMatchObject({ title: 'Widget' })
    })

    it('insertBatch adds multiple documents', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', {
        schema: { title: 'string' },
      })

      const batch = await nodeA.insertBatch('products', [{ title: 'Alpha' }, { title: 'Beta' }, { title: 'Gamma' }])

      expect(batch.succeeded.length).toBe(3)
      expect(batch.failed.length).toBe(0)
    })

    it('remove deletes a document', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', {
        schema: { title: 'string' },
      })

      const docId = await nodeA.insert('products', { title: 'ToRemove' })
      await nodeA.remove('products', docId)

      const result = await nodeA.query('products', { term: 'ToRemove' })
      expect(result.count).toBe(0)
    })

    it('removeBatch deletes multiple documents', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', {
        schema: { title: 'string' },
      })

      const id1 = await nodeA.insert('products', { title: 'RemoveMe1' })
      const id2 = await nodeA.insert('products', { title: 'RemoveMe2' })

      const batch = await nodeA.removeBatch('products', [id1, id2])
      expect(batch.succeeded.length).toBe(2)

      const result = await nodeA.query('products', { term: 'RemoveMe' })
      expect(result.count).toBe(0)
    })
  })

  describe('cluster namespace', () => {
    it('getAllocation returns null when no allocation exists', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      const allocation = await nodeA.cluster.getAllocation('nonexistent')
      expect(allocation).toBeNull()
    })

    it('getAllocation returns table after controller allocates', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      const assignments = new Map<number, PartitionAssignment>()
      assignments.set(0, makeAssignment({ primary: 'node-a', state: 'ACTIVE' }))
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      const allocation = await nodeA.cluster.getAllocation('products')
      expect(allocation).not.toBeNull()
      expect(allocation?.assignments.size).toBe(1)
    })

    it('getNodeInfo returns correct node information', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'coordinator'],
        }),
      )

      const info = nodeA.cluster.getNodeInfo()
      expect(info.nodeId).toBe('node-a')
      expect(info.roles).toEqual(['data', 'coordinator'])
      expect(info.status).toBe('stopped')
    })

    it('getNodeInfo reflects active status after start', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      const info = nodeA.cluster.getNodeInfo()
      expect(info.status).toBe('active')
    })
  })

  describe('shutdown', () => {
    it('deregisters from coordinator on shutdown', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      const nodesBefore = await coordinator.listNodes()
      expect(nodesBefore.find(n => n.nodeId === 'node-a')).toBeDefined()

      await nodeA.shutdown()
      nodeA = undefined

      const nodesAfter = await coordinator.listNodes()
      expect(nodesAfter.find(n => n.nodeId === 'node-a')).toBeUndefined()
    })

    it('stops controller on shutdown', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['controller'],
        }),
      )

      await nodeA.start()
      expect(nodeA.cluster.isControllerActive()).toBe(true)

      await nodeA.shutdown()

      expect(nodeA.cluster.isControllerActive()).toBe(false)
      nodeA = undefined
    })

    it('is idempotent', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.shutdown()
      await nodeA.shutdown()
      await nodeA.shutdown()
      nodeA = undefined
    })

    it('rejects operations after shutdown', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', { schema: { title: 'string' } })
      await nodeA.shutdown()

      await expect(nodeA.insert('products', { title: 'test' })).rejects.toThrow('shut down')

      await expect(nodeA.query('products', { term: 'test' })).rejects.toThrow('shut down')

      await expect(nodeA.createIndex('other', { schema: { x: 'string' } })).rejects.toThrow('shut down')

      nodeA = undefined
    })
  })

  describe('two-node cluster: insert on A, query on A', () => {
    it('inserts documents locally and queries them', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data', 'coordinator'],
        }),
      )

      await nodeA.start()
      await nodeB.start()

      await nodeA.createIndex('products', {
        schema: { title: 'string', price: 'number' },
      })

      await nodeA.insert('products', { title: 'Distributed Widget', price: 19.99 })
      await nodeA.insert('products', { title: 'Another Widget', price: 29.99 })

      const resultA = await nodeA.query('products', { term: 'Widget' })
      expect(resultA.count).toBe(2)
    })
  })

  describe('write routing with allocation table', () => {
    it('routes writes through allocation table when one exists', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', { schema: { title: 'string' } })

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, makeAssignment({ primary: 'node-a', state: 'ACTIVE' }))
      }
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      const docId = await nodeA.insert('products', { title: 'Routed Write' })
      expect(docId).toBeTruthy()
    })

    it('forwards write to remote primary when partition is owned by another node', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'coordinator'],
        }),
      )

      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data'],
        }),
      )

      await nodeB.start()

      await nodeB.createIndex('products', { schema: { title: 'string' } })

      await nodeA.start()

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, makeAssignment({ primary: 'node-b', state: 'ACTIVE' }))
      }
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      const docId = await nodeA.insert('products', { title: 'Remote Write' }, 'fixed-doc-id')
      expect(docId).toBe('fixed-doc-id')
    })
  })

  describe('createIndex validation of partitionCount and replicationFactor', () => {
    it('rejects partitionCount of 0', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await expect(
        nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: 0 }),
      ).rejects.toThrow('partitionCount must be an integer between 1 and 65536')
    })

    it('rejects negative partitionCount', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await expect(
        nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: -1 }),
      ).rejects.toThrow('partitionCount must be an integer between 1 and 65536')
    })

    it('rejects partitionCount exceeding 65536', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await expect(
        nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: 100_000 }),
      ).rejects.toThrow('partitionCount must be an integer between 1 and 65536')
    })

    it('rejects negative replicationFactor', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await expect(
        nodeA.createIndex('products', { schema: { title: 'string' } }, { replicationFactor: -1 }),
      ).rejects.toThrow('replicationFactor must be an integer between 0 and 255')
    })

    it('rejects replicationFactor exceeding 255', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await expect(
        nodeA.createIndex('products', { schema: { title: 'string' } }, { replicationFactor: 300 }),
      ).rejects.toThrow('replicationFactor must be an integer between 0 and 255')
    })

    it('rejects non-integer partitionCount', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await expect(
        nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: 2.5 }),
      ).rejects.toThrow('partitionCount must be an integer between 1 and 65536')
    })

    it('accepts valid edge values (partitionCount=1, replicationFactor=0)', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor: 0 })

      const schema = await coordinator.getSchema('products')
      expect(schema).toEqual({ title: 'string' })
    })
  })

  describe('insertBatch batching with allocation table', () => {
    it('insertBatch with multiple documents completes through allocation routing', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', { schema: { title: 'string' } })

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, makeAssignment({ primary: 'node-a', state: 'ACTIVE' }))
      }
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      const batch = await nodeA.insertBatch('products', [
        { title: 'Alpha' },
        { title: 'Beta' },
        { title: 'Gamma' },
        { title: 'Delta' },
        { title: 'Epsilon' },
      ])

      expect(batch.succeeded.length).toBe(5)
      expect(batch.failed.length).toBe(0)

      const result = await nodeA.query('products', { term: 'Alpha' })
      expect(result.count).toBe(1)
    })
  })

  describe('write forwarding across two nodes', () => {
    it('forwards insert to remote primary and the document is queryable on the remote node', async () => {
      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data'],
        }),
      )

      await nodeB.start()
      await nodeB.createIndex('products', { schema: { title: 'string', price: 'number' } })

      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'coordinator'],
        }),
      )

      await nodeA.start()

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, makeAssignment({ primary: 'node-b', state: 'ACTIVE' }))
      }
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      const docId = await nodeA.insert('products', { title: 'Forwarded Widget', price: 42.0 }, 'doc-forwarded')
      expect(docId).toBe('doc-forwarded')

      const resultOnB = await nodeB.query('products', { term: 'Forwarded' })
      expect(resultOnB.count).toBe(1)
      expect(resultOnB.hits[0].document).toMatchObject({ title: 'Forwarded Widget' })
    })

    it('forwards remove to remote primary', async () => {
      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data'],
        }),
      )

      await nodeB.start()
      await nodeB.createIndex('products', { schema: { title: 'string' } })

      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'coordinator'],
        }),
      )

      await nodeA.start()

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, makeAssignment({ primary: 'node-b', state: 'ACTIVE' }))
      }
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      await nodeA.insert('products', { title: 'ToRemove' }, 'doc-remove')
      await nodeA.remove('products', 'doc-remove')

      const resultOnB = await nodeB.query('products', { term: 'ToRemove' })
      expect(resultOnB.count).toBe(0)
    })

    it('forwards insertBatch with documents targeting a remote primary', async () => {
      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data'],
        }),
      )

      await nodeB.start()
      await nodeB.createIndex('products', { schema: { title: 'string' } })

      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'coordinator'],
        }),
      )

      await nodeA.start()

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, makeAssignment({ primary: 'node-b', state: 'ACTIVE' }))
      }
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      const batch = await nodeA.insertBatch('products', [
        { id: 'batch-1', title: 'First' },
        { id: 'batch-2', title: 'Second' },
      ])

      expect(batch.succeeded.length).toBe(2)
      expect(batch.failed.length).toBe(0)
    })
  })

  describe('distributed query via transport', () => {
    it('query fans out to remote node when partitions are ACTIVE on that node', async () => {
      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data'],
        }),
      )

      await nodeB.start()
      await nodeB.createIndex('products', { schema: { title: 'string' } })

      await nodeB.insert('products', { title: 'Remote Widget' }, 'doc-remote')

      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'coordinator'],
        }),
      )

      await nodeA.start()

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 1; i++) {
        assignments.set(i, makeAssignment({ primary: 'node-b', state: 'ACTIVE' }))
      }
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      const result = await nodeA.query('products', { term: 'Remote' })
      expect(result.count).toBe(1)
    })

    it('falls back to local engine when no partitions are ACTIVE', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'coordinator'],
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', { schema: { title: 'string' } })
      await nodeA.insert('products', { title: 'Local Widget' })

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, makeAssignment({ primary: 'node-a', state: 'INITIALISING' }))
      }
      await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

      const result = await nodeA.query('products', { term: 'Local' })
      expect(result.count).toBe(1)
    })
  })

  describe('message handler', () => {
    it('handles replication.forward messages and inserts documents', async () => {
      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data'],
        }),
      )

      await nodeB.start()
      await nodeB.createIndex('products', { schema: { title: 'string' } })

      const { encode } = await import('@msgpack/msgpack')
      const { createForwardMessage } = await import('../../../distribution/replication/codec')
      const { decode } = await import('@msgpack/msgpack')

      const forwardMsg = createForwardMessage(
        {
          indexName: 'products',
          documentId: 'msg-handler-doc',
          operation: 'insert',
          document: encode({ title: 'Handler Test' }),
          updateFields: null,
        },
        'node-a',
      )

      const response = await transportA.send('node-b', forwardMsg)
      const result = decode(response.payload) as Record<string, unknown>

      expect(result.documentId).toBe('msg-handler-doc')
      expect(result.success).toBe(true)

      const queryResult = await nodeB.query('products', { term: 'Handler' })
      expect(queryResult.count).toBe(1)
    })

    it('handles query.search messages and returns scored results', async () => {
      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data'],
        }),
      )

      await nodeB.start()
      await nodeB.createIndex('products', { schema: { title: 'string' } })
      await nodeB.insert('products', { title: 'Search Target' }, 'search-doc')

      const { decode } = await import('@msgpack/msgpack')
      const { createSearchMessage } = await import('../../../distribution/query/codec')

      const searchMsg = createSearchMessage(
        {
          indexName: 'products',
          partitionIds: [0],
          params: {
            term: 'Search',
            filters: null,
            sort: null,
            group: null,
            facets: null,
            facetSize: null,
            limit: 10,
            offset: 0,
            searchAfter: null,
            fields: null,
            boost: null,
            tolerance: null,
            threshold: null,
            scoring: 'local',
            vector: null,
            hybrid: null,
          },
          globalStats: null,
          facetShardSize: null,
        },
        'node-a',
      )

      const response = await transportA.send('node-b', searchMsg)
      const result = decode(response.payload) as { results: Array<{ totalHits: number }> }

      expect(result.results).toHaveLength(1)
      expect(result.results[0].totalHits).toBe(1)
    })

    it('write forwarding timeout produces a transport error', async () => {
      vi.useRealTimers()

      const fastNetwork = createInMemoryNetwork()
      const fastTransportA = createInMemoryTransport('fast-a', fastNetwork, { requestTimeout: 50 })
      createInMemoryTransport('fast-b', fastNetwork, { requestTimeout: 50 })

      const fastNodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: fastTransportA,
          address: 'fast-a:9200',
          nodeId: 'fast-a',
          roles: ['data', 'coordinator'],
        }),
      )

      await fastNodeA.start()
      await fastNodeA.createIndex('timeout-idx', { schema: { title: 'string' } })

      const assignments = new Map<number, PartitionAssignment>()
      for (let i = 0; i < 5; i++) {
        assignments.set(i, makeAssignment({ primary: 'fast-b', state: 'ACTIVE' }))
      }
      await coordinator.putAllocation('timeout-idx', makeAllocationTable('timeout-idx', assignments))

      await expect(fastNodeA.insert('timeout-idx', { title: 'Will Timeout' }, 'timeout-doc')).rejects.toThrow(
        /timed out/i,
      )

      await fastNodeA.shutdown()
      await fastTransportA.shutdown()
      vi.useFakeTimers()
    })
  })
})
