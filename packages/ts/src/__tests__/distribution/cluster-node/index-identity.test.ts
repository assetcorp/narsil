import { afterEach, describe, expect, it } from 'vitest'
import { getIndexMetadata, putIndexMetadata } from '../../../distribution/cluster/index-metadata'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { reconcileLocalIndexes } from '../../../distribution/cluster-node/local-index-reconcile'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'

const SCHEMA = { title: 'string' } as const

async function seedCoordinator(coordinator: ClusterCoordinator, indexName: string, indexUuid: string): Promise<void> {
  const stored = await putIndexMetadata(coordinator, {
    indexUuid,
    indexName,
    partitionCount: 2,
    replicationFactor: 1,
    constraints: { zoneAwareness: false, zoneAttribute: 'zone', maxShardsPerNode: null },
  })
  expect(stored).toBe(true)
  await coordinator.putSchema(indexName, SCHEMA)
}

describe('local index identity', () => {
  const engines: Array<{ shutdown: () => Promise<void> }> = []

  afterEach(async () => {
    while (engines.length > 0) {
      const engine = engines.pop()
      if (engine !== undefined) await engine.shutdown()
    }
  })

  async function engineHolding(indexName: string, indexUuid?: string) {
    const engine = await createClusterLocalEngine()
    engines.push(engine)
    await engine.createIndexWithUuid(indexName, { schema: SCHEMA }, indexUuid)
    return engine
  }

  it('reports the identity an index was created with', async () => {
    const engine = await engineHolding('products', 'uuid-one')
    expect(engine.indexUuidOf('products')).toBe('uuid-one')
  })

  it('reports no identity for an index created outside a cluster', async () => {
    const engine = await engineHolding('products')
    expect(engine.indexUuidOf('products')).toBeNull()
  })

  it('reports no index at all for a name it does not hold', async () => {
    const engine = await engineHolding('products', 'uuid-one')
    expect(engine.indexUuidOf('absent')).toBeUndefined()
  })

  it('adopts a local index whose identity matches the coordinator', async () => {
    const coordinator = createInMemoryCoordinator()
    await seedCoordinator(coordinator, 'products', 'uuid-one')
    const engine = await engineHolding('products', 'uuid-one')

    const dispositions = await reconcileLocalIndexes({ engine, coordinator, nodeId: 'node-a' })

    expect(dispositions.get('products')).toBe('adopted')
    expect(engine.listIndexes().map(index => index.name)).toEqual(['products'])
  })

  it('drops a local index the cluster replaced under the same name', async () => {
    const coordinator = createInMemoryCoordinator()
    await seedCoordinator(coordinator, 'products', 'uuid-two')
    const engine = await engineHolding('products', 'uuid-one')
    await engine.insert('products', { title: 'stale' }, 'doc-1')

    const dispositions = await reconcileLocalIndexes({ engine, coordinator, nodeId: 'node-a' })

    expect(dispositions.get('products')).toBe('superseded')
    expect(engine.listIndexes()).toEqual([])
  })

  it('keeps a local index the coordinator knows nothing about, and refuses to serve it', async () => {
    const coordinator = createInMemoryCoordinator()
    const engine = await engineHolding('products', 'uuid-one')
    await engine.insert('products', { title: 'kept' }, 'doc-1')

    const dispositions = await reconcileLocalIndexes({ engine, coordinator, nodeId: 'node-a' })

    expect(dispositions.get('products')).toBe('orphaned')
    expect(engine.listIndexes().map(index => index.name)).toEqual(['products'])
  })

  it('takes on the identity of an index that carries none, and keeps its documents', async () => {
    const coordinator = createInMemoryCoordinator()
    await seedCoordinator(coordinator, 'products', 'uuid-one')
    const engine = await engineHolding('products')
    await engine.insert('products', { title: 'kept' }, 'doc-1')

    const dispositions = await reconcileLocalIndexes({ engine, coordinator, nodeId: 'node-a' })

    expect(dispositions.get('products')).toBe('adopted')
    expect(engine.indexUuidOf('products')).toBe('uuid-one')
    expect(await engine.has('products', 'doc-1')).toBe(true)
  })

  it('reports the reason it refused an orphaned index', async () => {
    const coordinator = createInMemoryCoordinator()
    const engine = await engineHolding('products', 'uuid-one')
    const reported: Error[] = []

    await reconcileLocalIndexes({ engine, coordinator, nodeId: 'node-a', onError: error => reported.push(error) })

    expect(reported.length).toBe(1)
    expect(reported[0].message).toContain('products')
  })

  it('carries the identity into the metadata a coordinator stores and reads back', async () => {
    const coordinator = createInMemoryCoordinator()
    await seedCoordinator(coordinator, 'products', 'uuid-one')

    const metadata = await getIndexMetadata(coordinator, 'products')

    expect(metadata?.indexUuid).toBe('uuid-one')
  })
})
