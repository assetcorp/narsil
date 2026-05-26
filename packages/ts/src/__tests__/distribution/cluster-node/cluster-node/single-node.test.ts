import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { makeAllocationTable, makeAssignment, makeConfig } from './fixtures'

describe('createClusterNode (single node insert/query/cluster namespace/shutdown)', () => {
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
})
