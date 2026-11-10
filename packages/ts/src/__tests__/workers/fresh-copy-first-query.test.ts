import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../narsil'
import { createNarsil } from '../../narsil'
import type { QueryResult } from '../../types/results'
import type { QueryParams } from '../../types/search'
import {
  expectedCategoryCounts,
  expectedGroups,
  expectedPinnedPage,
  facetedQuery,
  groupedQuery,
  groupsById,
  pinnedQuery,
  READ_FEATURES_SCHEMA,
  shopItems,
} from '../search/read-features-corpus'
import { scaledOut, waitFor } from '../server/helpers'

const WORKERS_BUILT = existsSync(new URL('../../../dist/workers/entry.mjs', import.meta.url))
const ITEM_COUNT = 120
const PROMOTION_THRESHOLD = 50
const WORKER_COUNT = 2
const INDEX = 'shop'

const items = shopItems(ITEM_COUNT)
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

async function firstQueryOnFreshCopy(params: QueryParams): Promise<QueryResult> {
  const engine = await createNarsil({
    workers: {
      enabled: true,
      count: WORKER_COUNT,
      promotionThreshold: PROMOTION_THRESHOLD,
      mainCopyQueries: 'none',
    },
  })
  engines.push(engine)
  await engine.createIndex(INDEX, { schema: READ_FEATURES_SCHEMA })
  const written = await engine.insertBatch(INDEX, items)
  expect(written.failed).toEqual([])
  await waitFor(() => scaledOut(engine, INDEX))
  return engine.query(INDEX, params)
}

describe.skipIf(!WORKERS_BUILT)('the first read on a worker copy that has just started', () => {
  it('answers a grouped query with the cheapest matches of each category', async () => {
    const result = await firstQueryOnFreshCopy(groupedQuery)
    expect(groupsById(result.groups ?? [])).toEqual(expectedGroups(items))
  }, 60_000)

  it('answers a pinned query with the pinned outsider first and the matches by price after it', async () => {
    const result = await firstQueryOnFreshCopy(pinnedQuery(items))
    expect(result.hits.map(hit => hit.id)).toEqual(expectedPinnedPage(items))
  }, 60_000)

  it('answers a faceted query with the category counts of every match', async () => {
    const result = await firstQueryOnFreshCopy(facetedQuery)
    expect(result.facets?.category.values).toEqual(expectedCategoryCounts(items))
  }, 60_000)
})
