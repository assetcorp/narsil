import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { makeAllocationTable, makeAssignment, makeConfig } from './fixtures'

describe('createClusterNode (two-node, write routing, batching)', () => {
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
})
