import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireVectorSearchPool } from '../../../vector/search-pool'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

vi.mock('../../../vector/search-pool', () => ({
  acquireVectorSearchPool: vi.fn().mockResolvedValue(null),
  releaseVectorSearchPool: vi.fn().mockResolvedValue(undefined),
}))

const WORKER_COPY_MIN_VECTORS = 1024

async function insertAndBuild(index: VectorIndex, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
  }
  index.scheduleBuild()
  await new Promise(resolve => setTimeout(resolve, 0))
  await index.awaitPendingBuild()
}

describe('the vector search pool follows the worker copy switch', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.mocked(acquireVectorSearchPool).mockClear()
  })

  afterEach(() => {
    index.dispose()
  })

  it('never asks for a pool while worker copies are switched off', async () => {
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' }, { enabled: false })
    await insertAndBuild(index, WORKER_COPY_MIN_VECTORS + 16)
    const query = normalizedVector(DIM, 17)
    const options = { metric: 'cosine', minSimilarity: 0 } as const

    const parallel = await index.searchParallel(query, 10, options)

    expect(parallel).toEqual(index.search(query, 10, options))
    expect(vi.mocked(acquireVectorSearchPool)).not.toHaveBeenCalled()
  })

  it('asks for a pool of the size the switch allows', async () => {
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' }, { enabled: true, count: 3 })
    await insertAndBuild(index, WORKER_COPY_MIN_VECTORS + 16)

    await index.searchParallel(normalizedVector(DIM, 17), 10, { metric: 'cosine', minSimilarity: 0 })

    expect(vi.mocked(acquireVectorSearchPool)).toHaveBeenCalledWith(3)
  })
})
