import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

describe('VectorIndex search with HNSW (after build)', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  async function insertAndBuild(idx: VectorIndex, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      idx.insert(`doc${i}`, normalizedVector(DIM))
    }
    idx.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await idx.awaitPendingBuild()
  }

  it('after enough inserts to exceed promotionThreshold, scheduleBuild triggers a build', async () => {
    const statusBefore = index.maintenanceStatus()
    expect(statusBefore.graphCount).toBe(0)

    await insertAndBuild(index, 6)

    const statusAfter = index.maintenanceStatus()
    expect(statusAfter.graphCount).toBe(1)
  })

  it('after build completes, search uses HNSW and returns results', async () => {
    await insertAndBuild(index, 10)

    const results = index.search(normalizedVector(DIM), 5, {
      metric: 'cosine',
      minSimilarity: 0,
    })

    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('buffer candidates searched alongside HNSW results', async () => {
    await insertAndBuild(index, 6)

    const target = vectorFromValues(1, 0, 0, 0)
    index.insert('buffer-doc', vectorFromValues(0.99, 0.01, 0, 0))

    const results = index.search(target, 10, {
      metric: 'cosine',
      minSimilarity: 0,
    })

    expect(results.some(r => r.docId === 'buffer-doc')).toBe(true)
  })

  it('mergeResults deduplicates between HNSW and buffer results', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    index.insert('doc0', normalizedVector(DIM))

    const results = index.search(normalizedVector(DIM), 10, {
      metric: 'cosine',
      minSimilarity: 0,
    })

    const docIds = results.map(r => r.docId)
    const uniqueDocIds = new Set(docIds)
    expect(uniqueDocIds.size).toBe(docIds.length)
  })

  it('filtered search with low selectivity falls through to brute-force', async () => {
    const filteredIndex = createVectorIndex('vec', DIM, {
      threshold: 5,
      filterThreshold: 0.5,
      quantization: 'none',
    })
    try {
      await insertAndBuild(filteredIndex, 10)

      const filterIds = new Set(['doc0'])
      const results = filteredIndex.search(normalizedVector(DIM), 5, {
        metric: 'cosine',
        minSimilarity: 0,
        filterDocIds: filterIds,
      })

      expect(results.length).toBeLessThanOrEqual(1)
      if (results.length > 0) {
        expect(results[0].docId).toBe('doc0')
      }
    } finally {
      filteredIndex.dispose()
    }
  })

  it('efSearch parameter is forwarded to HNSW', async () => {
    await insertAndBuild(index, 10)

    const results = index.search(normalizedVector(DIM), 3, {
      metric: 'cosine',
      minSimilarity: 0,
      efSearch: 50,
    })

    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(3)
  })
})
