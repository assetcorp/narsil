import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { makeAllocationTable, makeAssignment, makeConfig } from './fixtures'

describe('createClusterNode (write forwarding across nodes, distributed query)', () => {
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
})
