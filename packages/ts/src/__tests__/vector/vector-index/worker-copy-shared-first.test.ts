import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VectorMetric } from '../../../vector/brute-force'
import { VECTOR_SCRATCH_SLOTS } from '../../../vector/constants'
import type { OrdinalFilter } from '../../../vector/ordinal-filter'
import type { OrdinalSearchResult, VectorSearchPool, WorkerCopySearchResult } from '../../../vector/search-pool'
import { acquireVectorSearchPool } from '../../../vector/search-pool'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../../../vector/shared-field/types'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { restoreWorkerCopy, type WorkerCopy, type WorkerCopySnapshot } from '../../../vector/worker-copy'
import { createFakeVectorThreads, DIM, normalizedVector } from './fixtures'

vi.mock('../../../vector/search-pool', () => ({
  acquireVectorSearchPool: vi.fn(),
  releaseVectorSearchPool: vi.fn().mockResolvedValue(undefined),
}))

const DOC_COUNT = 1040
const WORKER_THREAD_SLOT = VECTOR_SCRATCH_SLOTS - 1

interface FakePool {
  pool: VectorSearchPool
  loadShared: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  searchOrdinals: ReturnType<typeof vi.fn>
}

function createFakePool(): FakePool {
  const threads = createFakeVectorThreads(WORKER_THREAD_SLOT)
  const clones = new Map<string, WorkerCopy>()

  const loadShared = vi.fn(
    async (handle: string, handles: SharedVectorFieldHandles): Promise<boolean> => threads.open(handle, handles),
  )

  const load = vi.fn(async (handle: string, snapshot: WorkerCopySnapshot): Promise<boolean> => {
    clones.set(handle, restoreWorkerCopy(snapshot))
    return true
  })

  const searchOrdinals = vi.fn(
    async (
      handle: string,
      query: Float32Array,
      k: number,
      metric: VectorMetric,
      minSimilarity: number,
      efSearch?: number,
      filter?: OrdinalFilter,
    ): Promise<OrdinalSearchResult> =>
      threads.searchOrdinals(handle, query, k, metric, minSimilarity, efSearch, filter),
  )

  const pool: VectorSearchPool = {
    workerCount: 2,
    load,
    loadShared,
    searchOrdinals,

    async drop(handle: string): Promise<void> {
      threads.drop(handle)
      clones.delete(handle)
    },

    async insertOrdinals(handle: string, ordinals: Int32Array): Promise<GraphInsertOutcome | null> {
      return threads.insertOrdinals(handle, ordinals)
    },

    async search(
      handle: string,
      query: Float32Array,
      k: number,
      metric: VectorMetric,
      minSimilarity: number,
      efSearch?: number,
      filter?: OrdinalFilter,
    ): Promise<WorkerCopySearchResult[]> {
      const copy = clones.get(handle)
      if (copy === undefined) throw new Error(`No cloned copy for handle ${handle}`)
      return copy.graph
        .search(query, k, metric, minSimilarity, filter, efSearch)
        .map(result => ({ docId: result.docId, score: result.score }))
    },

    async shutdown(): Promise<void> {
      clones.clear()
    },
  }

  return { pool, loadShared, load, searchOrdinals }
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

async function awaitSharedAnswers(index: VectorIndex, fake: FakePool): Promise<void> {
  const warmUp = normalizedVector(DIM, 3)
  await vi.waitFor(async () => {
    await index.searchParallel(warmUp, 10, { metric: 'cosine', minSimilarity: 0 })
    expect(fake.searchOrdinals).toHaveBeenCalled()
  })
  fake.searchOrdinals.mockClear()
}

describe('worker copy loading picks the shared path first', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(acquireVectorSearchPool).mockReset()
  })

  it('answers from the graph the workers built, exactly as the calling thread does', async () => {
    const fake = createFakePool()
    vi.mocked(acquireVectorSearchPool).mockResolvedValue(fake.pool)
    const index = await buildIndex()
    await awaitSharedAnswers(index, fake)

    const query = normalizedVector(DIM, 17)
    const options = { metric: 'cosine', minSimilarity: 0 } as const
    const viaWorker = await index.searchParallel(query, 10, options)
    const local = index.search(query, 10, options)

    expect(fake.load).not.toHaveBeenCalled()
    expect(fake.searchOrdinals).toHaveBeenCalledTimes(1)
    expect(viaWorker.map(result => result.docId)).toEqual(local.map(result => result.docId))
    for (let position = 0; position < local.length; position++) {
      expect(Object.is(viaWorker[position].score, local[position].score)).toBe(true)
    }
    index.dispose()
  })

  it('answers a filtered search through the shared field exactly', async () => {
    const fake = createFakePool()
    vi.mocked(acquireVectorSearchPool).mockResolvedValue(fake.pool)
    const index = await buildIndex()
    await awaitSharedAnswers(index, fake)

    const query = normalizedVector(DIM, 31)
    const filterDocIds = new Set<string>()
    for (let i = 0; i < 100; i++) filterDocIds.add(`doc${i}`)
    const options = { metric: 'cosine', minSimilarity: 0, filterDocIds } as const

    const viaWorker = await index.searchParallel(query, 10, options)
    const local = index.search(query, 10, options)

    expect(fake.searchOrdinals).toHaveBeenCalledTimes(1)
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
    await awaitSharedAnswers(index, fake)

    const query = normalizedVector(DIM, 37)
    const filterDocIds = new Set<string>()
    for (let i = 0; i < 10; i++) filterDocIds.add(`doc${i}`)
    const options = { metric: 'cosine', minSimilarity: 0, filterDocIds } as const

    const filtered = await index.searchParallel(query, 10, options)
    const local = index.search(query, 10, options)

    expect(fake.searchOrdinals).not.toHaveBeenCalled()
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.map(result => result.docId)).toEqual(local.map(result => result.docId))
    index.dispose()
  })

  it('falls back to the cloned copy where the runtime shares no memory', async () => {
    const fake = createFakePool()
    vi.mocked(acquireVectorSearchPool).mockResolvedValue(fake.pool)
    vi.stubGlobal('SharedArrayBuffer', undefined)
    const index = await buildIndex()
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
