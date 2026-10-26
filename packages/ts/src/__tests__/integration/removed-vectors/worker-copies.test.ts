import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Narsil } from '../../../narsil'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import type { VectorSearchPool } from '../../../vector/search-pool'
import {
  backends,
  expectNearest,
  expectOnlyFrom,
  FAR_AWAY_OFFSET,
  large,
  openPapers,
  QUERY_COUNT,
  queries,
  queriesNearTheReembedded,
  reembed,
  SETTLE_DEADLINE_MS,
  search,
  searchWithTheHostBinary,
  untilGraphSettled,
} from './fixtures'

const poolUse = vi.hoisted(() => ({ holders: 0, clonedSearches: 0, sharedSearches: 0 }))

vi.mock('../../../vector/search-pool', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../vector/search-pool')>()
  function counted(pool: VectorSearchPool): VectorSearchPool {
    return {
      ...pool,
      search(...args) {
        poolUse.clonedSearches += 1
        return pool.search(...args)
      },
      searchOrdinals(...args) {
        poolUse.sharedSearches += 1
        return pool.searchOrdinals(...args)
      },
    }
  }
  return {
    ...actual,
    async acquireVectorSearchPool(requestedCount?: number) {
      poolUse.holders += 1
      const pool = await actual.acquireVectorSearchPool(requestedCount)
      return pool === null ? null : counted(pool)
    },
    async releaseVectorSearchPool() {
      if (poolUse.holders > 0) poolUse.holders -= 1
      await actual.releaseVectorSearchPool()
    },
  }
})

const MOVED_AGAIN_COUNT = 60
const BUFFERED_COUNT = 5

const workerPaths = [
  { path: 'shared memory', clones: false },
  { path: 'a cloned copy', clones: true },
]

async function untilWorkersAnswer(narsil: Narsil, clones: boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  const answered = () => (clones ? poolUse.clonedSearches : poolUse.sharedSearches)
  const before = answered()
  while (answered() === before) {
    if (Date.now() > deadline) throw new Error('no worker copy answered a search of papers after 20 s')
    await search(narsil, queries[0])
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function untilThePoolIsReleased(): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (poolUse.holders > 0) {
    if (Date.now() > deadline) throw new Error('the search pool still had a holder 20 s after shutdown')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

searchWithTheHostBinary()

describe.each(backends)('a vector search past re-embedded vectors on worker copies through $name', ({
  native,
  available,
}) => {
  const workerBackendVariable = native ? 'NARSIL_REQUIRE_NATIVE_CORE' : 'NARSIL_SEARCH_BACKEND'
  const previousValue = process.env[workerBackendVariable]
  let narsil: Narsil | null = null

  beforeEach(() => {
    setNativeSearchCoreEnabled(native)
    process.env[workerBackendVariable] = native ? '1' : 'wasm'
  })

  afterEach(async () => {
    await narsil?.shutdown()
    narsil = null
    vi.unstubAllGlobals()
    setNativeSearchCoreEnabled(true)
    if (previousValue === undefined) delete process.env[workerBackendVariable]
    else process.env[workerBackendVariable] = previousValue
    await untilThePoolIsReleased()
  })

  it.skipIf(!available).each(workerPaths)('answers from worker copies over $path', async ({ clones }) => {
    if (clones) vi.stubGlobal('SharedArrayBuffer', undefined)
    const opened = await openPapers({ workers: { count: 2 } }, large.documents)
    narsil = opened
    await reembed(opened, large)
    await untilWorkersAnswer(opened, clones)

    const answeredBefore = clones ? poolUse.clonedSearches : poolUse.sharedSearches
    await expectNearest(opened, [...large.kept, ...large.reembedded])
    await expectOnlyFrom(opened, large.reembedded, queriesNearTheReembedded)
    const answeredAfter = clones ? poolUse.clonedSearches : poolUse.sharedSearches
    expect(answeredAfter - answeredBefore).toBe(2 * QUERY_COUNT)
  })

  it.skipIf(!available).each(workerPaths)(
    'answers from worker copies over $path once a later update re-embeds a few more documents',
    async ({ clones }) => {
      if (clones) vi.stubGlobal('SharedArrayBuffer', undefined)
      const opened = await openPapers({ workers: { count: 2 } }, large.documents)
      narsil = opened
      await reembed(opened, large)
      await untilWorkersAnswer(opened, clones)

      const movedAgain = large.kept.slice(0, MOVED_AGAIN_COUNT).map(document => ({
        id: document.id,
        embedding: document.embedding.map(value => value - FAR_AWAY_OFFSET),
      }))
      const result = await opened.updateBatch(
        'papers',
        movedAgain.map(document => ({ docId: document.id, document })),
      )
      expect(result.failed).toEqual([])
      await untilGraphSettled(opened)
      await untilWorkersAnswer(opened, clones)

      const answeredBefore = clones ? poolUse.clonedSearches : poolUse.sharedSearches
      await expectOnlyFrom(
        opened,
        movedAgain,
        queries.map(query => query.map(value => value - FAR_AWAY_OFFSET)),
      )
      const answeredAfter = clones ? poolUse.clonedSearches : poolUse.sharedSearches
      expect(answeredAfter - answeredBefore).toBe(QUERY_COUNT)
    },
  )

  it.skipIf(!available).each(workerPaths)(
    'answers from worker copies over $path with re-embedded documents that the graph has not taken in yet',
    async ({ clones }) => {
      if (clones) vi.stubGlobal('SharedArrayBuffer', undefined)
      const opened = await openPapers({ workers: { count: 2 } }, large.documents)
      narsil = opened
      await untilWorkersAnswer(opened, clones)

      const movedFew = large.kept.slice(0, BUFFERED_COUNT).map(document => ({
        id: document.id,
        embedding: document.embedding.map(value => value - FAR_AWAY_OFFSET),
      }))
      const result = await opened.updateBatch(
        'papers',
        movedFew.map(document => ({ docId: document.id, document })),
      )
      expect(result.failed).toEqual([])
      await untilWorkersAnswer(opened, clones)
      expect(opened.vectorMaintenanceStatus('papers')[0]?.bufferSize).toBe(BUFFERED_COUNT)

      const moved = new Set(movedFew.map(document => document.id))
      const answeredBefore = clones ? poolUse.clonedSearches : poolUse.sharedSearches
      for (const query of queries) {
        const found = await search(
          opened,
          query.map(value => value - FAR_AWAY_OFFSET),
        )
        expect(found.hits.slice(0, BUFFERED_COUNT).filter(hit => moved.has(hit.id))).toHaveLength(BUFFERED_COUNT)
      }
      const answeredAfter = clones ? poolUse.clonedSearches : poolUse.sharedSearches
      expect(answeredAfter - answeredBefore).toBe(QUERY_COUNT)
    },
  )
})
