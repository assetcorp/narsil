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

  it('defaults constraint fields when they are missing from stored data', async () => {
    const metadata: IndexMetadata = {
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
