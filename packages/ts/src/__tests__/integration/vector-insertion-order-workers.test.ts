import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { VectorSearchPool } from '../../vector/search-pool'
import { waitFor } from '../server/helpers'
import {
  DIMENSION,
  FIELD,
  insertFileByFile,
  NARROW_EF_SEARCH,
  NARROW_LIMIT,
  passagesArrivingFileByFile,
  passagesNotFoundFirst,
  SETTLE_TIMEOUT_MS,
  savedCounts,
  snapshotFromAnEarlierRelease,
  untilSettled,
  vectorHits,
} from './passages-by-file'
import { walkSavedGraph } from './saved-graph-walk'

const poolUse = vi.hoisted(() => ({ holders: 0, sharedSearches: 0 }))

vi.mock('../../vector/search-pool', async importOriginal => {
  const actual = await importOriginal<typeof import('../../vector/search-pool')>()
  function counted(pool: VectorSearchPool): VectorSearchPool {
    return {
      ...pool,
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

const SAVED_PASSAGES = 2_000
const WORKER_COUNT = 2
const TEST_TIMEOUT_MS = 300_000
const INDEX = 'passages'
const RESTORED_INDEX = 'earlier'
const EF_SEARCH_AFTER_A_PARALLEL_BUILD = 2_000

describe('a worker copy of a graph that a load rebuilds', () => {
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await waitFor(async () => poolUse.holders === 0, SETTLE_TIMEOUT_MS)
  })

  it(
    'reaches every passage and answers each one first from the rebuilt graph that the workers share',
    async () => {
      const opened = await createNarsil({ workers: { count: WORKER_COUNT } })
      engine = opened
      const passages = passagesArrivingFileByFile(SAVED_PASSAGES)
      await opened.createIndex(INDEX, {
        schema: { [FIELD]: `vector[${DIMENSION}]` },
        vectorPromotion: { quantization: 'osq4', threshold: SAVED_PASSAGES },
      })
      await insertFileByFile(opened, INDEX, passages)

      await opened.restore(RESTORED_INDEX, await snapshotFromAnEarlierRelease(opened, INDEX, SAVED_PASSAGES))
      await waitFor(async () => (await savedCounts(opened, RESTORED_INDEX))[0] === SAVED_PASSAGES, SETTLE_TIMEOUT_MS)
      await untilSettled(opened, RESTORED_INDEX)
      const answeredBeforeSettling = poolUse.sharedSearches
      await waitFor(async () => {
        await vectorHits(opened, RESTORED_INDEX, passages[0].embedding, NARROW_LIMIT, NARROW_EF_SEARCH)
        return poolUse.sharedSearches > answeredBeforeSettling
      }, SETTLE_TIMEOUT_MS)

      const walk = await walkSavedGraph(await opened.snapshot(RESTORED_INDEX), RESTORED_INDEX, FIELD)
      expect({ unplaced: walk.unplaced, unreached: walk.unreached }).toEqual({ unplaced: [], unreached: [] })

      const answeredBefore = poolUse.sharedSearches
      const missed = await passagesNotFoundFirst(
        opened,
        RESTORED_INDEX,
        passages,
        NARROW_LIMIT,
        EF_SEARCH_AFTER_A_PARALLEL_BUILD,
      )
      expect(missed).toEqual([])
      expect(poolUse.sharedSearches - answeredBefore).toBe(SAVED_PASSAGES)
    },
    TEST_TIMEOUT_MS,
  )
})
