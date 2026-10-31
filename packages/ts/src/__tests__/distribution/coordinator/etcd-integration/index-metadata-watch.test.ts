import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterCoordinator, IndexMetadataEvent } from '../../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('watching index metadata on etcd', () => {
  let container: EtcdContainerHandle | null = null
  let coordinator: ClusterCoordinator | null = null

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
    } else {
      await runDocker(['version'])
      container = await startEtcdContainer()
    }
    coordinator = await createEtcdCoordinator({
      endpoints: [container.endpoint],
      keyPrefix: `_narsil_etcd_integration_${randomUUID()}`,
      nodeHeartbeatTtlSeconds: 5,
    })
  }, 90_000)

  afterAll(async () => {
    await coordinator?.shutdown()
    await stopEtcdContainer(container?.name ?? null)
  }, 30_000)

  it('reports each change in order, and only for the config key of an index', async () => {
    if (coordinator === null) throw new Error('the etcd coordinator did not start')
    const events: IndexMetadataEvent[] = []
    const stop = await coordinator.watchIndexMetadata(event => events.push(event))

    await coordinator.compareAndSet('_narsil/index/articles/config', null, bytes(1))
    await coordinator.compareAndSet('_narsil/index/articles/config', bytes(1), bytes(2))
    await coordinator.compareAndSet('_narsil/index/articles/rebalance', null, bytes(3))
    await coordinator.compareAndSet('_narsil/index/nested/name/config', null, bytes(4))
    await coordinator.compareAndSet('_narsil/synonyms/articles/config', null, bytes(6))
    await coordinator.compareAndSet('_narsil/index/articles/config', bytes(2), bytes())
    await coordinator.compareAndSet('_narsil/index/products/config', null, bytes(7))
    await coordinator.delete('_narsil/index/products/config')

    const expected = [
      { indexName: 'articles', metadata: bytes(1) },
      { indexName: 'articles', metadata: bytes(2) },
      { indexName: 'articles', metadata: null },
      { indexName: 'products', metadata: bytes(7) },
      { indexName: 'products', metadata: null },
    ]
    await eventually(
      async () => {
        expect(events).toEqual(expected)
      },
      5_000,
      'Timed out waiting for index metadata events',
    )

    stop()
    await coordinator.compareAndSet('_narsil/index/late/config', null, bytes(8))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(events).toEqual(expected)
  })
})
