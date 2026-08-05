import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireVectorSearchPool, releaseVectorSearchPool } from '../../../vector/search-pool'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

vi.mock('../../../vector/search-pool', () => ({
  acquireVectorSearchPool: vi.fn().mockResolvedValue(null),
  releaseVectorSearchPool: vi.fn().mockResolvedValue(undefined),
}))

const REPLICA_MIN_VECTORS = 1024

async function insertAndBuild(index: VectorIndex, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    index.insert(`doc${i}`, normalizedVector(DIM))
  }
  index.scheduleBuild()
  await new Promise(resolve => setTimeout(resolve, 0))
  await index.awaitPendingBuild()
  expect(index.maintenanceStatus().graphCount).toBe(1)
}

describe('searchParallel without a worker pool', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.mocked(acquireVectorSearchPool).mockClear()
    vi.mocked(releaseVectorSearchPool).mockClear()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
  })

  it('answers from the main thread and matches the synchronous search', async () => {
    await insertAndBuild(index, REPLICA_MIN_VECTORS + 16)
    const query = normalizedVector(DIM)
    const options = { metric: 'cosine', minSimilarity: 0 } as const

    const parallel = await index.searchParallel(query, 10, options)

    expect(parallel).toEqual(index.search(query, 10, options))
    expect(parallel).toHaveLength(10)
  })

  it('asks for a pool once and stops asking while the attempt is in flight', async () => {
    await insertAndBuild(index, REPLICA_MIN_VECTORS + 16)
    const query = normalizedVector(DIM)
    const options = { metric: 'cosine', minSimilarity: 0 } as const

    await index.searchParallel(query, 5, options)
    await index.searchParallel(query, 5, options)
    await index.searchParallel(query, 5, options)

    expect(vi.mocked(acquireVectorSearchPool).mock.calls.length).toBeLessThanOrEqual(3)
    expect(vi.mocked(acquireVectorSearchPool)).toHaveBeenCalled()
    expect(vi.mocked(releaseVectorSearchPool)).toHaveBeenCalled()
  })

  it('never reaches for a pool below the replica threshold', async () => {
    await insertAndBuild(index, 32)
    const query = normalizedVector(DIM)
    const options = { metric: 'cosine', minSimilarity: 0 } as const

    const parallel = await index.searchParallel(query, 5, options)

    expect(parallel).toEqual(index.search(query, 5, options))
    expect(vi.mocked(acquireVectorSearchPool)).not.toHaveBeenCalled()
  })

  it('keeps a filtered query on the main thread', async () => {
    await insertAndBuild(index, REPLICA_MIN_VECTORS + 16)
    const query = normalizedVector(DIM)
    const filterDocIds = new Set(['doc1', 'doc2', 'doc3'])
    const options = { metric: 'cosine', minSimilarity: 0, filterDocIds } as const

    const parallel = await index.searchParallel(query, 3, options)

    expect(parallel).toEqual(index.search(query, 3, options))
    expect(parallel.every(result => filterDocIds.has(result.docId))).toBe(true)
    expect(vi.mocked(acquireVectorSearchPool)).not.toHaveBeenCalled()
  })

  it('still answers after the index is emptied by deletes', async () => {
    await insertAndBuild(index, REPLICA_MIN_VECTORS + 16)
    for (let i = 0; i < REPLICA_MIN_VECTORS + 16; i++) index.remove(`doc${i}`)
    const query = normalizedVector(DIM)
    const options = { metric: 'cosine', minSimilarity: 0 } as const

    await expect(index.searchParallel(query, 5, options)).resolves.toEqual([])
  })
})
