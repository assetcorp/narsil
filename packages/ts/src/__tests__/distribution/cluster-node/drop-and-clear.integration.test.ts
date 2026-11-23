import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { startSingleNodeCluster, waitForActiveAllocation, waitForSettledReplica } from './cluster-harness'

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

  it('serves only the new documents when a dropped name is created again at once', async () => {
    if (nodeA === undefined || nodeB === undefined) throw new Error('nodes missing')

    await nodeA.dropIndex('products')
    await nodeA.createIndex('products', { schema: { title: 'string', price: 'number' } }, { partitionCount: 2 })
    await nodeA.insert('products', { title: 'Rebuilt Gadget', price: 5 }, 'gadget-rebuilt')

    for (const node of [nodeA, nodeB]) {
      expect(await node.countDocuments('products')).toBe(1)
      const stored = await node.getMultiple('products', ['gadget-0', 'gadget-14', 'gadget-rebuilt'])
      expect([...stored.keys()]).toEqual(['gadget-rebuilt'])
      expect((await node.query('products', { term: 'Gadget', limit: 50 })).hits.map(hit => hit.id)).toEqual([
        'gadget-rebuilt',
      ])
    }
  }, 30_000)
})

describe('cluster-node drop of an index the cluster never allocated', () => {
  it('drops an index that only exists locally when the cluster never allocated it', async () => {
    const cluster = await startSingleNodeCluster()
    try {
      await expect(cluster.node.dropIndex('never-created')).rejects.toThrow(
        expect.objectContaining({ code: 'INDEX_NOT_FOUND' }) as unknown as Error,
      )
    } finally {
      await cluster.shutdown()
    }
  }, 30_000)
})

describe('cluster-node drop while no controller holds the lease', () => {
  it('finishes the drop once a controller starts, because that controller tears down the stored allocation', async () => {
    const coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    const transports = ['controller-a', 'data-node', 'controller-b'].map(id => createInMemoryTransport(id, network))
    const [transportA, transportData, transportB] = transports
    if (transportA === undefined || transportData === undefined || transportB === undefined) {
      throw new Error('transports missing')
    }
    const controllerA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'controller-a:9200',
      nodeId: 'controller-a',
      roles: ['controller'],
    })
    const dataNode = await createClusterNode({
      coordinator,
      transport: transportData,
      address: 'data-node:9200',
      nodeId: 'data-node',
      roles: ['data', 'coordinator'],
    })
    const controllerB = await createClusterNode({
      coordinator,
      transport: transportB,
      address: 'controller-b:9200',
      nodeId: 'controller-b',
      roles: ['controller'],
    })
    try {
      await controllerA.start()
      await dataNode.start()
      await dataNode.createIndex('products', { schema: { title: 'string', price: 'number' } })
      await waitForActiveAllocation(coordinator, 'products')
      await controllerA.shutdown()

      const dropOutcome = dataNode.dropIndex('products').then(
        () => null,
        (error: unknown) => error,
      )
      expect(await pollUntil(async () => (await coordinator.getSchema('products')) === null)).toBe(true)
      expect(await coordinator.getAllocation('products')).not.toBeNull()

      await controllerB.start()
      expect(await dropOutcome).toBeNull()
      expect(await coordinator.getAllocation('products')).toBeNull()
      expect(await coordinator.listAllocations()).toEqual([])
    } finally {
      await controllerB.shutdown()
      await dataNode.shutdown()
      await controllerA.shutdown()
      for (const transport of transports) await transport.shutdown()
      await coordinator.shutdown()
    }
  }, 60_000)
})
