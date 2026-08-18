import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchOrdinals as searchSharedOrdinals } from '../../../vector/hnsw/search'
import type { OrdinalSearchResult, VectorSearchPool, WorkerCopySearchResult } from '../../../vector/search-pool'
import { acquireVectorSearchPool } from '../../../vector/search-pool'
import type { SharedGenerationSnapshot } from '../../../vector/shared-generation/types'
import { openSharedWorkerCopy } from '../../../vector/shared-generation/worker-view'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { restoreWorkerCopy, type WorkerCopy, type WorkerCopySnapshot } from '../../../vector/worker-copy'
import { DIM, normalizedVector } from './fixtures'

vi.mock('../../../vector/search-pool', () => ({
  acquireVectorSearchPool: vi.fn(),
  releaseVectorSearchPool: vi.fn().mockResolvedValue(undefined),
}))

const DOC_COUNT = 1040

interface FakePool {
  pool: VectorSearchPool
  loadShared: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
}

function createFakePool(): FakePool {
  const sharedHandles = new Map<string, SharedGenerationSnapshot>()
  const cloneHandles = new Map<string, WorkerCopy>()

  const loadShared = vi.fn(async (handle: string, snapshot: SharedGenerationSnapshot): Promise<boolean> => {
    sharedHandles.set(handle, snapshot)
    return true
  })
  const load = vi.fn(async (handle: string, snapshot: WorkerCopySnapshot): Promise<boolean> => {
    cloneHandles.set(handle, restoreWorkerCopy(snapshot))
    return true
  })

  const pool: VectorSearchPool = {
    workerCount: 2,
    scratchSlotCount: 2,
    load,
    loadShared,
    async drop(handle: string): Promise<void> {
      sharedHandles.delete(handle)
      cloneHandles.delete(handle)
    },
    async search(handle, query, k, metric, minSimilarity, efSearch, filter): Promise<WorkerCopySearchResult[]> {
      const copy = cloneHandles.get(handle)
      if (!copy) throw new Error(`No cloned copy for handle ${handle}`)
      return copy.graph
        .search(query, k, metric, minSimilarity, filter, efSearch)
        .map(result => ({ docId: result.docId, score: result.score }))
    },
    async searchOrdinals(handle, query, k, metric, minSimilarity, efSearch, filter): Promise<OrdinalSearchResult> {
      const snapshot = sharedHandles.get(handle)
      if (!snapshot) throw new Error(`No shared copy for handle ${handle}`)
      const copy = openSharedWorkerCopy(snapshot, 0)
      const hits = searchSharedOrdinals(
        copy.searchState,
        query,
        k,
        metric,
        minSimilarity,
        copy.rankByOrdinal,
        filter,
        efSearch,
      )
      return {
        ordinals: Uint32Array.from(hits.map(hit => hit.ord)),
        scores: Float64Array.from(hits.map(hit => hit.score)),
      }
    },
    async shutdown(): Promise<void> {
      sharedHandles.clear()
      cloneHandles.clear()
    },
  }

  return { pool, loadShared, load }
}

async function buildIndex(): Promise<VectorIndex> {
  const index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'sq8' })
  for (let i = 0; i < DOC_COUNT; i++) {
    index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
  }
  index.scheduleBuild()
  await new Promise(resolve => setTimeout(resolve, 0))
  await index.awaitPendingBuild()
  expect(index.maintenanceStatus().graphCount).toBe(1)
  return index
}

describe('worker copy loading picks the shared path first', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(acquireVectorSearchPool).mockReset()
  })

  it('freezes one shared copy and answers through it exactly', async () => {
    const fake = createFakePool()
    vi.mocked(acquireVectorSearchPool).mockResolvedValue(fake.pool)
    const index = await buildIndex()
    const query = normalizedVector(DIM, 17)
    const options = { metric: 'cosine', minSimilarity: 0 } as const

    await index.searchParallel(query, 10, options)
    await vi.waitFor(() => expect(fake.loadShared).toHaveBeenCalledTimes(1))

    const viaWorker = await index.searchParallel(query, 10, options)
    const local = index.search(query, 10, options)

    expect(fake.load).not.toHaveBeenCalled()
    expect(viaWorker.map(result => result.docId)).toEqual(local.map(result => result.docId))
    for (let position = 0; position < local.length; position++) {
      expect(Object.is(viaWorker[position].score, local[position].score)).toBe(true)
    }
    index.dispose()
  })

  it('answers a filtered search through the shared copy exactly', async () => {
    const fake = createFakePool()
    vi.mocked(acquireVectorSearchPool).mockResolvedValue(fake.pool)
    const index = await buildIndex()
    const query = normalizedVector(DIM, 31)
    const filterDocIds = new Set<string>()
    for (let i = 0; i < 100; i++) filterDocIds.add(`doc${i}`)
    const options = { metric: 'cosine', minSimilarity: 0, filterDocIds } as const

    await index.searchParallel(query, 10, options)
    await vi.waitFor(() => expect(fake.loadShared).toHaveBeenCalledTimes(1))

    const ordinalSearches = vi.spyOn(fake.pool, 'searchOrdinals')
    const viaWorker = await index.searchParallel(query, 10, options)
    const local = index.search(query, 10, options)

    expect(ordinalSearches).toHaveBeenCalledTimes(1)
    expect(viaWorker.length).toBeGreaterThan(0)
    for (const result of viaWorker) {
      expect(filterDocIds.has(result.docId)).toBe(true)
    }
    expect(viaWorker.map(result => result.docId)).toEqual(local.map(result => result.docId))
    for (let position = 0; position < local.length; position++) {
      expect(Object.is(viaWorker[position].score, local[position].score)).toBe(true)
    }
    index.dispose()
  })

  it('keeps a highly selective filter on the calling thread', async () => {
    const fake = createFakePool()
    vi.mocked(acquireVectorSearchPool).mockResolvedValue(fake.pool)
    const index = await buildIndex()
    const query = normalizedVector(DIM, 37)

    await index.searchParallel(query, 10, { metric: 'cosine', minSimilarity: 0 })
    await vi.waitFor(() => expect(fake.loadShared).toHaveBeenCalledTimes(1))

    const filterDocIds = new Set<string>()
    for (let i = 0; i < 10; i++) filterDocIds.add(`doc${i}`)
    const options = { metric: 'cosine', minSimilarity: 0, filterDocIds } as const

    const ordinalSearches = vi.spyOn(fake.pool, 'searchOrdinals')
    const filtered = await index.searchParallel(query, 10, options)
    const local = index.search(query, 10, options)

    expect(ordinalSearches).not.toHaveBeenCalled()
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.map(result => result.docId)).toEqual(local.map(result => result.docId))
    index.dispose()
  })

  it('falls back to the cloned copy where the runtime lacks SharedArrayBuffer', async () => {
    const fake = createFakePool()
    vi.mocked(acquireVectorSearchPool).mockResolvedValue(fake.pool)
    const index = await buildIndex()
    vi.stubGlobal('SharedArrayBuffer', undefined)
    const query = normalizedVector(DIM, 23)
    const options = { metric: 'cosine', minSimilarity: 0 } as const

    await index.searchParallel(query, 10, options)
    await vi.waitFor(() => expect(fake.load).toHaveBeenCalledTimes(1))

    const viaWorker = await index.searchParallel(query, 10, options)
    const local = index.search(query, 10, options)

    expect(fake.loadShared).not.toHaveBeenCalled()
    expect(viaWorker.map(result => result.docId)).toEqual(local.map(result => result.docId))
    for (let position = 0; position < local.length; position++) {
      expect(Object.is(viaWorker[position].score, local[position].score)).toBe(true)
    }
    index.dispose()
  })
})
