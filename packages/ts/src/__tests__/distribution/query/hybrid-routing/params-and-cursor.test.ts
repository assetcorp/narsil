import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wireParamsToLocal } from '../../../../distribution/cluster-node/query-conversion'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import { decodePayload } from '../../../../distribution/query/codec'
import { distributedQuery } from '../../../../distribution/query/routing'
import type { QueryRoutingDeps } from '../../../../distribution/query/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
  QueryMessageTypes,
} from '../../../../distribution/transport'
import type { SearchPayload, StatsResultPayload } from '../../../../distribution/transport/types'
import { NarsilError } from '../../../../errors'
import { encodePageCursor } from '../../../../search/cursor'
import { queryBindingOf } from '../../../../search/cursor-binding'
import {
  makeAllocationTable,
  makeAssignment,
  makeHybridConfig,
  makeQueryParams,
  makeSearchResultResponse,
  makeVectorParams,
  setupDataNode,
} from './fixtures'

describe('distributed hybrid query - params, cursor, and DFS', () => {
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

  it('strips hybrid config from both text and vector fan-out params', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    for (const payload of receivedPayloads) {
      expect(payload.params.hybrid).toBeNull()
    }
  })

  it('returns no cursor, because a fused rank cannot be replayed', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type !== QueryMessageTypes.SEARCH) return
      const payload = decodePayload<SearchPayload>(msg.payload)
      const isTextRequest = payload.params.term !== null

      const result = isTextRequest
        ? makeSearchResultResponse([
            {
              partitionId: 0,
              scored: [
                { docId: 'doc-a', score: 10.0 },
                { docId: 'doc-b', score: 5.0 },
              ],
              totalHits: 2,
            },
          ])
        : makeSearchResultResponse([
            {
              partitionId: 0,
              scored: [
                { docId: 'doc-c', score: 0.9 },
                { docId: 'doc-d', score: 0.5 },
              ],
              totalHits: 2,
            },
          ])

      respond({
        type: QueryMessageTypes.SEARCH_RESULT,
        sourceId: 'node-a',
        requestId: msg.requestId,
        payload: encode(result),
      })
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(result.scored.length).toBeGreaterThan(0)
    expect(result.cursor).toBeNull()
  })

  it('returns null cursor when hybrid search produces no results', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(makeSearchResultResponse([{ partitionId: 0, scored: [], totalHits: 0 }])),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery(
      'products',
      makeQueryParams({ term: 'nonexistent', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(result.scored).toHaveLength(0)
    expect(result.cursor).toBeNull()
  })

  it('preserves filters in both text and vector fan-out params', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const filters = { category: 'electronics' }
    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({
        term: 'laptop',
        vector: makeVectorParams(),
        hybrid: makeHybridConfig(),
        filters,
      }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(2)
    for (const payload of receivedPayloads) {
      expect(payload.params.filters).toEqual(filters)
    }
  })

  it('throws SEARCH_INVALID_CURSOR when searchAfter is used with hybrid', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const cursor = encodePageCursor({
      anchor: 'doc-1',
      score: 5.0,
      sortKey: null,
      sortSignature: null,
      binding: queryBindingOf(
        wireParamsToLocal(makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() })),
      ),
    })

    const error = await distributedQuery(
      'products',
      makeQueryParams({
        term: 'laptop',
        vector: makeVectorParams(),
        hybrid: makeHybridConfig(),
        searchAfter: cursor,
      }),
      makeDeps(table),
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
    expect((error as NarsilError).message).toContain('Cursor pagination is not supported for hybrid queries')
  })

  it('rejects a hybrid query carrying a sort with SEARCH_INVALID_MODE', async () => {
    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])

    const error = await distributedQuery(
      'products',
      makeQueryParams({
        term: 'laptop',
        vector: makeVectorParams(),
        hybrid: makeHybridConfig(),
        sort: [{ field: 'title', direction: 'asc' }],
      }),
      makeDeps(table),
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_MODE')
  })

  it('performs DFS stats pre-pass then two fan-outs for hybrid with dfs scoring', async () => {
    const messageTypes: string[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      messageTypes.push(msg.type)

      if (msg.type === QueryMessageTypes.STATS) {
        const statsResult: StatsResultPayload = {
          totalDocuments: 100,
          docFrequencies: { laptop: 50 },
          totalFieldLengths: { title: 1000 },
        }
        respond({
          type: QueryMessageTypes.STATS_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(statsResult),
        })
        return
      }

      if (msg.type === QueryMessageTypes.SEARCH) {
        const payload = decodePayload<SearchPayload>(msg.payload)
        const isTextRequest = payload.params.term !== null

        const result = isTextRequest
          ? makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-a', score: 10.0 }], totalHits: 1 }])
          : makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-b', score: 0.9 }], totalHits: 1 }])

        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(result),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery(
      'products',
      makeQueryParams({
        term: 'laptop',
        vector: makeVectorParams(),
        hybrid: makeHybridConfig({ strategy: 'rrf', k: 60 }),
        scoring: 'dfs',
      }),
      makeDeps(table),
    )

    const statsCount = messageTypes.filter(t => t === QueryMessageTypes.STATS).length
    const searchCount = messageTypes.filter(t => t === QueryMessageTypes.SEARCH).length
    expect(statsCount).toBe(1)
    expect(searchCount).toBe(2)
    expect(result.scored.length).toBeGreaterThan(0)
  })
})
