import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { waitForSettledReplica } from './cluster-harness'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

describe('cluster-node drop and clear', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network)
    transportB = createInMemoryTransport('node-b', network)

    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()
    await nodeA.createIndex('products', { schema: { title: 'string', price: 'number' } })

    nodeB = await createClusterNode({
      coordinator,
      transport: transportB,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
    })
    await nodeB.start()

    await waitForSettledReplica(coordinator, 'products', 'node-b')

    const inserted = await nodeA.insertBatch(
      'products',
      Array.from({ length: 15 }, (_, index) => ({
        id: `gadget-${index}`,
        title: `Foldable Gadget ${index}`,
        price: index,
      })),
    )
    expect(inserted.failed).toEqual([])
  }, 30_000)

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
  })

  it('clears every document across the cluster and keeps the index serving', async () => {
    if (nodeA === undefined || nodeB === undefined) throw new Error('nodes missing')

    expect(await nodeA.countDocuments('products')).toBe(15)
    await nodeA.clear('products')

    expect(await nodeA.countDocuments('products')).toBe(0)
    const viaReplica = await pollUntil(async () => {
      const result = await nodeB?.query('products', { term: 'Foldable' })
      return result?.count === 0
    })
    expect(viaReplica).toBe(true)

    expect(await coordinator.getSchema('products')).not.toBeNull()
    expect(await coordinator.getAllocation('products')).not.toBeNull()

    await nodeA.insert('products', { title: 'Fresh Gadget', price: 99 }, 'gadget-fresh')
    expect(await nodeA.countDocuments('products')).toBe(1)
  }, 30_000)

  it('drops the index from the coordinator and from every node, and the name can be reused', async () => {
    if (nodeA === undefined || nodeB === undefined) throw new Error('nodes missing')

    await nodeA.dropIndex('products')

    const stateGone = await pollUntil(async () => {
      const schema = await coordinator.getSchema('products')
      const allocation = await coordinator.getAllocation('products')
      return schema === null && allocation === null
    })
    expect(stateGone).toBe(true)

    const localCopiesGone = await pollUntil(async () => {
      try {
        await nodeA?.query('products', { term: 'Foldable' })
        return false
      } catch (err) {
        return (err as { code?: string }).code === 'INDEX_NOT_FOUND'
      }
    })
    expect(localCopiesGone).toBe(true)

    await nodeA.createIndex('products', { schema: { title: 'string', price: 'number' } })
    const reallocated = await pollUntil(async () => {
      const table = await coordinator.getAllocation('products')
      if (table === null || table.assignments.size === 0) return false
      for (const assignment of table.assignments.values()) {
        if (assignment.state !== 'ACTIVE') return false
      }
      return true
    })
    expect(reallocated).toBe(true)

    await nodeA.insert('products', { title: 'Rebuilt Gadget', price: 5 }, 'gadget-rebuilt')
    const answered = await nodeA.query('products', { term: 'Rebuilt' })
    expect(answered.count).toBe(1)
  }, 30_000)

  it('drops an index that only exists locally when the cluster never allocated it', async () => {
    if (nodeA === undefined) throw new Error('node missing')
    await expect(nodeA.dropIndex('never-created')).rejects.toThrow(
      expect.objectContaining({ code: 'INDEX_NOT_FOUND' }) as unknown as Error,
    )
  }, 30_000)
})
