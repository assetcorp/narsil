import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PARTITION_COUNT } from '../../../../distribution/cluster-node'
import { type ClusterLocalEngine, createClusterLocalEngine } from '../../../../distribution/cluster-node/local-engine'
import { routeCreateIndex } from '../../../../distribution/cluster-node/write-routing'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'

describe('routeCreateIndex partition layout', () => {
  let coordinator: ClusterCoordinator
  let engine: ClusterLocalEngine

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    engine = await createClusterLocalEngine()
  })

  afterEach(async () => {
    await engine.shutdown()
    await coordinator.shutdown()
  })

  it('creates the local index with the cluster partition count', async () => {
    await routeCreateIndex('products', { schema: { title: 'string' } }, { partitionCount: 4 }, coordinator, engine)

    expect(engine.getStats('products').partitionCount).toBe(4)
    expect(engine.indexUuidOf('products')).toEqual(expect.any(String))
  })

  it('creates the local index with the default cluster partition count when no count is given', async () => {
    await routeCreateIndex('products', { schema: { title: 'string' } }, undefined, coordinator, engine)

    expect(engine.getStats('products').partitionCount).toBe(DEFAULT_PARTITION_COUNT)
  })

  it('keeps the caller partition settings while forcing the cluster partition count', async () => {
    await routeCreateIndex(
      'products',
      { schema: { title: 'string' }, partitions: { maxDocsPerPartition: 100 } },
      { partitionCount: 2 },
      coordinator,
      engine,
    )

    expect(engine.getStats('products').partitionCount).toBe(2)
  })
})
