import { describe, expect, it, vi } from 'vitest'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'

function stubClusterNode(): ClusterNode {
  return {
    nodeId: 'node-a',
    roles: ['data'],
    createIndex: vi.fn(async () => undefined),
    insert: vi.fn(async () => 'doc-1'),
    insertBatch: vi.fn(async () => ({ succeeded: [], failed: [] })),
    remove: vi.fn(async () => undefined),
    removeBatch: vi.fn(async () => ({ succeeded: [], failed: [] })),
    query: vi.fn(async () => ({ hits: [], count: 0, elapsed: 0 })),
    get: vi.fn(async () => ({ title: 'stored' })),
    getMultiple: vi.fn(async () => new Map()),
    has: vi.fn(async () => true),
    cluster: {
      getAllocation: vi.fn(async () => null),
      getNodeInfo: vi.fn(() => ({ nodeId: 'node-a', roles: ['data'], status: 'joined' })),
      isControllerActive: vi.fn(() => false),
    },
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  } as unknown as ClusterNode
}

describe('clusterNodeEngine', () => {
  it('routes the served operations through the cluster node', async () => {
    const node = stubClusterNode()
    const engine = clusterNodeEngine(node, { createIndex: { partitionCount: 6, replicationFactor: 2 } })

    await engine.createIndex('products', { schema: { title: 'string' } })
    expect(node.createIndex).toHaveBeenCalledWith(
      'products',
      { schema: { title: 'string' } },
      { partitionCount: 6, replicationFactor: 2 },
    )

    await engine.insert('products', { title: 'a' }, 'doc-1')
    expect(node.insert).toHaveBeenCalledWith('products', { title: 'a' }, 'doc-1')

    await engine.insertBatch('products', [{ title: 'a' }])
    await engine.remove('products', 'doc-1')
    await engine.removeBatch('products', ['doc-1'])
    await engine.query('products', { term: 'a' })
    await engine.get('products', 'doc-1')
    await engine.getMultiple('products', ['doc-1'])
    await engine.has('products', 'doc-1')
    await engine.shutdown()

    expect(node.query).toHaveBeenCalledWith('products', { term: 'a' })
    expect(node.get).toHaveBeenCalledWith('products', 'doc-1')
    expect(node.shutdown).toHaveBeenCalled()
  })

  it('passes no spread settings when the adapter is built without them', async () => {
    const node = stubClusterNode()
    const engine = clusterNodeEngine(node)

    await engine.createIndex('products', { schema: { title: 'string' } })
    expect(node.createIndex).toHaveBeenCalledWith('products', { schema: { title: 'string' } }, undefined)
  })

  it('refuses every operation a cluster node does not serve', () => {
    const engine = clusterNodeEngine(stubClusterNode())

    const refused: Array<() => unknown> = [
      () => engine.registerEmbeddingAdapter('x', { dimensions: 3, embed: async () => new Float32Array(3) }),
      () => engine.dropIndex('products'),
      () => engine.listIndexes(),
      () => engine.getStats('products'),
      () => engine.getPartitionStats('products'),
      () => engine.update('products', 'doc-1', {}),
      () => engine.updateBatch('products', []),
      () => engine.countDocuments('products'),
      () => engine.listDocuments('products'),
      () => engine.preflight('products', { term: 'a' }),
      () => engine.suggest('products', { prefix: 'a' }),
      () => engine.rebuildAnalysis('products'),
      () => engine.snapshot('products'),
      () => engine.restore('products', new Uint8Array()),
      () => engine.checkpoint('products'),
      () => engine.clear('products'),
      () => engine.rebalance('products', 2),
      () => engine.updatePartitionConfig('products', {}),
      () => engine.getMemoryStats(),
      () => engine.compactVectors('products'),
      () => engine.optimizeVectors('products'),
      () => engine.vectorMaintenanceStatus('products'),
      () => engine.on('persistenceError', () => undefined),
      () => engine.off('persistenceError', () => undefined),
    ]

    for (const call of refused) {
      expect(call).toThrowError(expect.objectContaining({ code: 'CLUSTER_OPERATION_UNSUPPORTED' }) as unknown as Error)
    }
  })
})
