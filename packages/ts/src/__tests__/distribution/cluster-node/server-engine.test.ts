import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { type ClusterCoordinator, createInMemoryCoordinator } from '../../../distribution/coordinator'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import type { Narsil } from '../../../types/engine'

const UNSUPPORTED = { code: 'CLUSTER_OPERATION_UNSUPPORTED' }

describe('a cluster node behind the engine interface', () => {
  let coordinator: ClusterCoordinator
  let transport: NodeTransport
  let node: ClusterNode
  let engine: Narsil

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    transport = createInMemoryTransport('node-a', createInMemoryNetwork(), { requestTimeout: 500 })
    node = await createClusterNode({
      roles: ['data', 'controller'],
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
    })
    await node.start()
    engine = clusterNodeEngine(node, { createIndex: { partitionCount: 2, replicationFactor: 0 } })
    await engine.createIndex('products', { schema: { title: 'string' } })
  })

  afterEach(async () => {
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('stores, finds, changes, and removes a document through the cluster', async () => {
    await engine.insert('products', { title: 'desk lamp' }, 'lamp')
    await engine.insertBatch('products', [{ id: 'chair', title: 'office chair' }])

    expect(await engine.get('products', 'lamp')).toMatchObject({ title: 'desk lamp' })
    expect(await engine.countDocuments('products')).toBe(2)
    expect((await engine.query('products', { term: 'lamp' })).hits.map(hit => hit.id)).toEqual(['lamp'])

    await engine.update('products', 'lamp', { title: 'floor light' })
    expect((await engine.query('products', { term: 'lamp' })).hits).toEqual([])
    expect((await engine.query('products', { term: 'light' })).hits.map(hit => hit.id)).toEqual(['lamp'])

    await engine.remove('products', 'chair')
    expect(await engine.has('products', 'chair')).toBe(false)
    expect(await engine.countDocuments('products')).toBe(1)
  })

  it('spreads a created index by the settings the adapter was given', async () => {
    const stats = await node.getStats('products')
    expect(stats.partitionCount).toBe(2)
  })

  it('refuses every operation a cluster node leaves to a single engine', () => {
    const refused: Array<() => unknown> = [
      () => engine.registerEmbeddingAdapter('x', { dimensions: 3, embed: async () => new Float32Array(3) }),
      () => engine.listIndexes(),
      () => engine.getStats('products'),
      () => engine.getPartitionStats('products'),
      () => engine.snapshot('products'),
      () => engine.restore('products', new Uint8Array()),
      () => engine.updatePartitionConfig('products', {}),
      () => engine.compactVectors('products'),
      () => engine.optimizeVectors('products'),
      () => engine.vectorMaintenanceStatus('products'),
    ]
    for (const call of refused) {
      expect(call).toThrowError(expect.objectContaining(UNSUPPORTED) as unknown as Error)
    }
  })

  it('refuses a write that asks to wait for the copies and stores nothing', async () => {
    const waiting = { wait: true }
    const refused: Array<Promise<unknown>> = [
      engine.insert('products', { title: 'a' }, 'waited', waiting),
      engine.insertBatch('products', [{ id: 'waited', title: 'a' }], waiting),
      engine.remove('products', 'waited', waiting),
      engine.removeBatch('products', ['waited'], waiting),
      engine.update('products', 'waited', { title: 'b' }, waiting),
      engine.updateBatch('products', [{ docId: 'waited', document: { title: 'b' } }], waiting),
    ]
    for (const call of refused) await expect(call).rejects.toMatchObject(UNSUPPORTED)
    expect(await engine.countDocuments('products')).toBe(0)
  })
})
