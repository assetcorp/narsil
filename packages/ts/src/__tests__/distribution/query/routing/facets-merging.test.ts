import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import type { QueryRoutingDeps } from '../../../../distribution/query/routing'
import { distributedQuery } from '../../../../distribution/query/routing'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
} from '../../../../distribution/transport'
import {
  createSearchResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

describe('distributedQuery facets merging', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  const transports: NodeTransport[] = []

  function makeDeps(allocationTable: AllocationTable | null): QueryRoutingDeps {
    return {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => allocationTable,
    }
  }

  beforeEach(() => {
    network = createInMemoryNetwork()
    coordinatorTransport = createInMemoryTransport('coordinator', network)
    transports.push(coordinatorTransport)
  })

  afterEach(async () => {
    for (const t of transports) {
      await t.shutdown()
    }
    transports.length = 0
  })

  it('merges facets from multiple nodes by summing counts', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse(
        [{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }],
        {
          color: [
            { value: 'red', count: 10 },
            { value: 'blue', count: 5 },
          ],
        },
      )
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    setupDataNode(network, transports, 'node-b', (msg, respond) => {
      const resultPayload = makeSearchResultResponse(
        [{ partitionId: 1, scored: [{ docId: 'doc-2', score: 4.0 }], totalHits: 1 }],
        {
          color: [
            { value: 'red', count: 8 },
            { value: 'green', count: 3 },
          ],
        },
      )
      respond(createSearchResultMessage(resultPayload, 'node-b', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])

    const result = await distributedQuery('products', makeQueryParams({ facets: ['color'] }), makeDeps(table))

    expect(result.facets).not.toBeNull()
    const colorBuckets = result.facets?.color
    expect(colorBuckets).toBeDefined()
    expect(colorBuckets?.[0]).toEqual({ value: 'red', count: 18 })
    expect(colorBuckets?.[1]).toEqual({ value: 'blue', count: 5 })
    expect(colorBuckets?.[2]).toEqual({ value: 'green', count: 3 })
  })

  it('truncates merged facets to facetSize', async () => {
    const manyBuckets = Array.from({ length: 30 }, (_, i) => ({
      value: `color-${String(i).padStart(2, '0')}`,
      count: 30 - i,
    }))

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse(
        [{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }],
        { color: manyBuckets.slice(0, 15) },
      )
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    setupDataNode(network, transports, 'node-b', (msg, respond) => {
      const resultPayload = makeSearchResultResponse(
        [{ partitionId: 1, scored: [{ docId: 'doc-2', score: 4.0 }], totalHits: 1 }],
        { color: manyBuckets.slice(15, 30) },
      )
      respond(createSearchResultMessage(resultPayload, 'node-b', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])

    const result = await distributedQuery(
      'products',
      makeQueryParams({ facets: ['color'], facetSize: 5 }),
      makeDeps(table),
    )

    expect(result.facets).not.toBeNull()
    const colorBuckets = result.facets?.color
    expect(colorBuckets).toHaveLength(5)
    expect(colorBuckets?.[0].count).toBe(30)
    expect(colorBuckets?.[4].count).toBe(26)
  })

  it('uses default facetSize of 10 when neither params nor config specify it', async () => {
    const manyBuckets = Array.from({ length: 20 }, (_, i) => ({
      value: `tag-${String(i).padStart(2, '0')}`,
      count: 20 - i,
    }))

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse(
        [{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }],
        { tag: manyBuckets },
      )
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery('products', makeQueryParams({ facets: ['tag'] }), makeDeps(table))

    expect(result.facets).not.toBeNull()
    expect(result.facets?.tag).toHaveLength(10)
  })
})
