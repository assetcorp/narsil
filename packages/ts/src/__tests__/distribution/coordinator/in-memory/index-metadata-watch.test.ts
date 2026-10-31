import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClusterCoordinator, IndexMetadataEvent } from '../../../../distribution/coordinator'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('watching index metadata on the in-memory coordinator', () => {
  let coordinator: ClusterCoordinator

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  it('reports each change in order, and only for the config key of an index', async () => {
    const events: IndexMetadataEvent[] = []
    const stop = await coordinator.watchIndexMetadata(event => events.push(event))

    await coordinator.compareAndSet('_narsil/index/articles/config', null, bytes(1))
    await coordinator.compareAndSet('_narsil/index/articles/config', bytes(1), bytes(2))
    await coordinator.compareAndSet('_narsil/index/articles/rebalance', null, bytes(3))
    await coordinator.compareAndSet('_narsil/index/nested/name/config', null, bytes(4))
    await coordinator.compareAndSet('_narsil/index//config', null, bytes(5))
    await coordinator.compareAndSet('_narsil/synonyms/articles/config', null, bytes(6))
    await coordinator.compareAndSet('_narsil/index/articles/config', bytes(2), bytes())
    await coordinator.compareAndSet('_narsil/index/products/config', null, bytes(7))
    await coordinator.delete('_narsil/index/products/config')

    expect(events).toEqual([
      { indexName: 'articles', metadata: bytes(1) },
      { indexName: 'articles', metadata: bytes(2) },
      { indexName: 'articles', metadata: null },
      { indexName: 'products', metadata: bytes(7) },
      { indexName: 'products', metadata: null },
    ])

    stop()
    await coordinator.compareAndSet('_narsil/index/late/config', null, bytes(8))
    expect(events).toHaveLength(5)
  })

  it('keeps telling other watchers after one handler throws, and hands out its own bytes', async () => {
    const events: IndexMetadataEvent[] = []
    await coordinator.watchIndexMetadata(() => {
      throw new Error('a handler that fails')
    })
    await coordinator.watchIndexMetadata(event => {
      events.push(event)
      if (event.metadata !== null) event.metadata[0] = 99
    })

    await coordinator.compareAndSet('_narsil/index/articles/config', null, bytes(1))

    expect(events).toHaveLength(1)
    expect(await coordinator.get('_narsil/index/articles/config')).toEqual(bytes(1))
  })
})
