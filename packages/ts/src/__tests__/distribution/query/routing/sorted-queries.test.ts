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
import { NarsilError } from '../../../../errors'
import { decodePageCursor, encodePageCursor } from '../../../../search/cursor'
import {
  createSearchResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

const TITLE_SORT = [{ field: 'title', direction: 'asc' as const }]
const TITLE_SIGNATURE = '[["title","asc"]]'

describe('distributedQuery with a sort', () => {
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

  it('merges node results by the sort value order, not by score', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [
            { docId: 'doc-2', score: 1.0, sortValues: ['apple'] },
            { docId: 'doc-4', score: 9.0, sortValues: ['Zebra'] },
          ],
          totalHits: 2,
        },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })
    setupDataNode(network, transports, 'node-b', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 1,
          scored: [
            { docId: 'doc-1', score: 2.0, sortValues: ['Apple'] },
            { docId: 'doc-3', score: 8.0, sortValues: ['Banana'] },
          ],
          totalHits: 2,
        },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-b', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])
    const result = await distributedQuery('products', makeQueryParams({ sort: TITLE_SORT }), makeDeps(table))

    expect(result.scored.map(entry => entry.docId)).toEqual(['doc-1', 'doc-2', 'doc-3', 'doc-4'])
  })

  it('encodes a sorted cursor carrying the last sort key and the sort order', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [
            { docId: 'doc-1', score: 1.0, sortValues: ['Apple'] },
            { docId: 'doc-2', score: 2.0, sortValues: ['Banana'] },
          ],
          totalHits: 2,
        },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery('products', makeQueryParams({ sort: TITLE_SORT }), makeDeps(table))

    expect(result.cursor).not.toBeNull()
    const decoded = decodePageCursor(result.cursor as string)
    expect(decoded.anchor).toBe('doc-2')
    expect(decoded.score).toBeNull()
    expect(decoded.sortKey).toEqual(['Banana'])
    expect(decoded.sortSignature).toBe(TITLE_SIGNATURE)
  })

  it('treats a node answering a sorted query without sort values as failed', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 1.0, sortValues: ['Apple'] }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })
    setupDataNode(network, transports, 'node-b', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        { partitionId: 1, scored: [{ docId: 'doc-2', score: 2.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-b', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])
    const result = await distributedQuery('products', makeQueryParams({ sort: TITLE_SORT }), makeDeps(table))

    expect(result.scored.map(entry => entry.docId)).toEqual(['doc-1'])
    expect(result.coverage.failedPartitions).toBe(1)
    expect(result.coverage.queriedPartitions).toBe(1)

    let error: unknown
    try {
      await distributedQuery('products', makeQueryParams({ sort: TITLE_SORT }), makeDeps(table), {
        allowPartialResults: false,
      })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('QUERY_PARTIAL_FAILURE')
  })

  it('rejects a cursor made under a different sort', async () => {
    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const cursor = encodePageCursor({
      anchor: 'doc-1',
      score: null,
      sortKey: [10],
      sortSignature: '[["price","desc"]]',
    })

    let error: unknown
    try {
      await distributedQuery('products', makeQueryParams({ sort: TITLE_SORT, searchAfter: cursor }), makeDeps(table))
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })
})
