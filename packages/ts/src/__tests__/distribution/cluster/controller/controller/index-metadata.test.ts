import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexMetadata } from '../../../../../distribution/cluster/controller'
import { getIndexMetadata, putIndexMetadata } from '../../../../../distribution/cluster/controller'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../../../distribution/coordinator/types'
import { defaultConstraints } from './fixtures'

describe('IndexMetadata', () => {
  let coordinator: ClusterCoordinator

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  it('round-trips metadata through put and get', async () => {
    const metadata: IndexMetadata = {
      indexUuid: 'uuid-products',
      indexName: 'products',
      partitionCount: 5,
      replicationFactor: 2,
      constraints: {
        zoneAwareness: true,
        zoneAttribute: 'rack',
        maxShardsPerNode: 10,
      },
    }

    const stored = await putIndexMetadata(coordinator, metadata)
    expect(stored).toBe(true)

    const retrieved = await getIndexMetadata(coordinator, 'products')
    expect(retrieved).not.toBeNull()
    expect(retrieved?.indexName).toBe('products')
    expect(retrieved?.partitionCount).toBe(5)
    expect(retrieved?.replicationFactor).toBe(2)
    expect(retrieved?.constraints.zoneAwareness).toBe(true)
    expect(retrieved?.constraints.zoneAttribute).toBe('rack')
    expect(retrieved?.constraints.maxShardsPerNode).toBe(10)
  })

  it('returns null for non-existent metadata', async () => {
    const retrieved = await getIndexMetadata(coordinator, 'nonexistent')
    expect(retrieved).toBeNull()
  })

  it('prevents overwriting existing metadata via compareAndSet', async () => {
    const metadata = {
      indexUuid: 'uuid-products',
      indexName: 'products',
      partitionCount: 3,
      replicationFactor: 1,
      constraints: defaultConstraints,
    }

    const first = await putIndexMetadata(coordinator, metadata)
    expect(first).toBe(true)

    const second = await putIndexMetadata(coordinator, { ...metadata, partitionCount: 10 })
    expect(second).toBe(false)

    const retrieved = await getIndexMetadata(coordinator, 'products')
    expect(retrieved?.partitionCount).toBe(3)
  })

  it('treats an emptied metadata key as absent, so a dropped name can be recreated', async () => {
    const metadata = {
      indexUuid: 'uuid-products',
      indexName: 'products',
      partitionCount: 3,
      replicationFactor: 1,
      constraints: defaultConstraints,
    }
    expect(await putIndexMetadata(coordinator, metadata)).toBe(true)

    const current = await coordinator.get('_narsil/index/products/config')
    expect(current).not.toBeNull()
    if (current === null) throw new Error('metadata is missing')
    expect(await coordinator.compareAndSet('_narsil/index/products/config', current, new Uint8Array(0))).toBe(true)

    expect(await getIndexMetadata(coordinator, 'products')).toBeNull()
    expect(await putIndexMetadata(coordinator, { ...metadata, partitionCount: 4 })).toBe(true)
    expect((await getIndexMetadata(coordinator, 'products'))?.partitionCount).toBe(4)
  })

  it('defaults constraint fields when they are missing from stored data', async () => {
    const metadata: IndexMetadata = {
      indexUuid: 'uuid-articles',
      indexName: 'articles',
      partitionCount: 2,
      replicationFactor: 0,
      constraints: {
        zoneAwareness: false,
        zoneAttribute: 'zone',
        maxShardsPerNode: null,
      },
    }

    await putIndexMetadata(coordinator, metadata)
    const retrieved = await getIndexMetadata(coordinator, 'articles')
    expect(retrieved?.constraints.zoneAwareness).toBe(false)
    expect(retrieved?.constraints.zoneAttribute).toBe('zone')
    expect(retrieved?.constraints.maxShardsPerNode).toBeNull()
  })
})
