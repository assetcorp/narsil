import { describe, expect, it } from 'vitest'
import { createAnalysisRebuildCoordinator } from '../../engine/analysis-rebuild'
import { getLanguage } from '../../languages/registry'
import { createPartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'

describe('analysis rebuild lifecycle', () => {
  it('keeps a closed stale index pending until its manager is loaded', async () => {
    const manager = createPartitionManager(
      'open',
      { schema: { title: 'string' } },
      getLanguage('english'),
      createPartitionRouter(),
    )
    const managers = new Map([['open', manager]])
    const coordinator = createAnalysisRebuildCoordinator(undefined, {
      getManager: indexName => managers.get(indexName),
      desyncIndex: () => false,
      async resyncIndex() {},
      async persistAnalysisRevision() {},
      emit() {},
    })
    coordinator.markStale({ indexName: 'open', language: 'english', storedRevision: null, currentRevision: '1' })
    coordinator.markStale({ indexName: 'closed', language: 'english', storedRevision: null, currentRevision: '1' })

    await coordinator.reviewStaleIndexes()
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(coordinator.isStale('closed')).toBe(true)
  })

  it('rebuilds after a reopen when a close beat the queued rebuild', async () => {
    const manager = createPartitionManager(
      'products',
      { schema: { title: 'string' } },
      getLanguage('english'),
      createPartitionRouter(),
    )
    const managers = new Map([['products', manager]])
    const coordinator = createAnalysisRebuildCoordinator(undefined, {
      getManager: indexName => managers.get(indexName),
      desyncIndex: () => false,
      async resyncIndex() {},
      async persistAnalysisRevision() {},
      emit() {},
    })
    coordinator.markStale({ indexName: 'products', language: 'english', storedRevision: null, currentRevision: '1' })

    const queued = coordinator.rebuild('products')
    managers.delete('products')
    await queued

    expect(coordinator.isStale('products')).toBe(true)
    expect(coordinator.isRunning('products')).toBe(false)

    managers.set('products', manager)
    await coordinator.review('products')
    await coordinator.rebuild('products')

    expect(coordinator.isStale('products')).toBe(false)
  })
})
