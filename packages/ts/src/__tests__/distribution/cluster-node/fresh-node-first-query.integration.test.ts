import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryResult } from '../../../types/results'
import type { QueryParams } from '../../../types/search'
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
} from '../../search/read-features-corpus'

const ITEM_COUNT = 60
const PARTITION_COUNT = 4
const INDEX = 'shop'

const items = shopItems(ITEM_COUNT)
const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

async function startShelfNode() {
  vi.resetModules()
  const [{ createClusterNode }, { createInMemoryCoordinator }, transports, { waitForActiveAllocation }] =
    await Promise.all([
      import('../../../distribution/cluster-node'),
      import('../../../distribution/coordinator'),
      import('../../../distribution/transport'),
      import('./cluster-harness'),
    ])
  const coordinator = createInMemoryCoordinator()
  const network = transports.createInMemoryNetwork()
  const transport = transports.createInMemoryTransport('shelf', network)
  const shelf = await createClusterNode({
    coordinator,
    transport,
    address: 'shelf:9200',
    nodeId: 'shelf',
    roles: ['data', 'controller'],
  })
  teardowns.push(async () => {
    await shelf.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })
  await shelf.start()
  await shelf.createIndex(
    INDEX,
    { schema: READ_FEATURES_SCHEMA },
    { partitionCount: PARTITION_COUNT, replicationFactor: 0 },
  )
  await waitForActiveAllocation(coordinator, INDEX)
  expect((await shelf.insertBatch(INDEX, items)).failed).toEqual([])
  return { coordinator, network }
}

async function firstQueryOnFreshRouter(params: QueryParams): Promise<QueryResult> {
  const { coordinator, network } = await startShelfNode()
  vi.resetModules()
  const [{ createClusterNode }, { createInMemoryTransport }] = await Promise.all([
    import('../../../distribution/cluster-node'),
    import('../../../distribution/transport'),
  ])
  const transport = createInMemoryTransport('router', network)
  const router = await createClusterNode({
    coordinator,
    transport,
    address: 'router:9200',
    nodeId: 'router',
    roles: ['coordinator'],
  })
  teardowns.push(async () => {
    await router.shutdown()
    await transport.shutdown()
  })
  await router.start()
  return router.query(INDEX, params)
}

describe('the first read on a coordinating cluster node that has just started in a separate module graph', () => {
  it('merges a grouped query into the cheapest matches of each category', async () => {
    const result = await firstQueryOnFreshRouter(groupedQuery)
    expect(groupsById(result.groups ?? [])).toEqual(expectedGroups(items))
  }, 60_000)

  it('places the pinned outsider first and the matches by price after it', async () => {
    const result = await firstQueryOnFreshRouter(pinnedQuery(items))
    expect(result.hits.map(hit => hit.id)).toEqual(expectedPinnedPage(items))
  }, 60_000)

  it('merges the category counts of every match across partitions', async () => {
    const result = await firstQueryOnFreshRouter(facetedQuery)
    expect(result.facets?.category.values).toEqual(expectedCategoryCounts(items))
  }, 60_000)
})
