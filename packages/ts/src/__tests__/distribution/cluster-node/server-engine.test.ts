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
    update: vi.fn(async () => undefined),
    updateBatch: vi.fn(async () => ({ succeeded: [], failed: [] })),
    dropIndex: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    countDocuments: vi.fn(async () => 0),
    listDocuments: vi.fn(async () => ({ documents: [], cursor: null, total: 0, elapsed: 0 })),
    suggest: vi.fn(async () => ({ terms: [], elapsed: 0 })),
    preflight: vi.fn(async () => ({ count: 0, elapsed: 0 })),
    getStats: vi.fn(async () => ({
      documentCount: 0,
      partitionCount: 0,
      estimatedMemoryBytes: 0,
      language: 'english',
      schema: {},
    })),
    getPartitionStats: vi.fn(async () => []),
    checkpoint: vi.fn(async () => undefined),
    getMemoryStats: vi.fn(async () => ({ process: null, estimatedIndexBytes: 0, workers: [] })),
    on: vi.fn(),
    off: vi.fn(),
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
    expect(node.insert).toHaveBeenCalledWith('products', { title: 'a' }, 'doc-1', undefined)

    await engine.insertBatch('products', [{ title: 'a' }], { skipClone: true })
    expect(node.insertBatch).toHaveBeenCalledWith('products', [{ title: 'a' }], { skipClone: true })
    await engine.remove('products', 'doc-1')
    await engine.removeBatch('products', ['doc-1'])
    await engine.update('products', 'doc-1', { title: 'b' })
    await engine.updateBatch('products', [{ docId: 'doc-1', document: { title: 'b' } }])
    await engine.dropIndex('products')
    await engine.clear('products')
    await engine.countDocuments('products')
    await engine.listDocuments('products', { limit: 5 })
    await engine.suggest('products', { prefix: 'a' })
    await engine.preflight('products', { term: 'a' })
    await engine.checkpoint('products')
    await engine.getMemoryStats()
    const listener = (): void => undefined
    engine.on('durabilityError', listener)
    engine.off('durabilityError', listener)
    await engine.query('products', { term: 'a' })
    await engine.get('products', 'doc-1')
    await engine.getMultiple('products', ['doc-1'])
    await engine.has('products', 'doc-1')
    await engine.shutdown()

    expect(node.update).toHaveBeenCalledWith('products', 'doc-1', { title: 'b' })
    expect(node.updateBatch).toHaveBeenCalledWith('products', [{ docId: 'doc-1', document: { title: 'b' } }])
    expect(node.dropIndex).toHaveBeenCalledWith('products')
    expect(node.clear).toHaveBeenCalledWith('products')
    expect(node.countDocuments).toHaveBeenCalledWith('products')
    expect(node.listDocuments).toHaveBeenCalledWith('products', { limit: 5 })
    expect(node.suggest).toHaveBeenCalledWith('products', { prefix: 'a' })
    expect(node.preflight).toHaveBeenCalledWith('products', { term: 'a' })
    expect(node.checkpoint).toHaveBeenCalledWith('products')
    expect(node.getMemoryStats).toHaveBeenCalled()
    expect(node.on).toHaveBeenCalledWith('durabilityError', listener)
    expect(node.off).toHaveBeenCalledWith('durabilityError', listener)
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
      () => engine.listIndexes(),
      () => engine.getStats('products'),
      () => engine.getPartitionStats('products'),
      () => engine.rebuildAnalysis('products'),
      () => engine.snapshot('products'),
      () => engine.restore('products', new Uint8Array()),
      () => engine.rebalance('products', 2),
      () => engine.updatePartitionConfig('products', {}),
      () => engine.compactVectors('products'),
      () => engine.optimizeVectors('products'),
      () => engine.vectorMaintenanceStatus('products'),
    ]

    for (const call of refused) {
      expect(call).toThrowError(expect.objectContaining({ code: 'CLUSTER_OPERATION_UNSUPPORTED' }) as unknown as Error)
    }
  })
})
