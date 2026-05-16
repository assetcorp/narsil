import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import type { SearchPayload } from '../../../../distribution/transport/types'
import { NarsilError } from '../../../../errors'
import {
  makeAllocationTable,
  makeAssignment,
  makeHybridConfig,
  makeQueryParams,
  makeSearchResultResponse,
  makeVectorParams,
  setupDataNode,
} from './fixtures'

describe('distributed hybrid query - coverage and facets', () => {
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

  it('reports worst-case coverage across both fan-outs', async () => {
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

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-unreachable' })],
    ])

    const result = await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
      { allowPartialResults: true },
    )

    expect(result.coverage.totalPartitions).toBe(2)
    expect(result.coverage.failedPartitions).toBe(1)
    expect(result.coverage.queriedPartitions).toBe(1)
  })

  it('only the text fan-out carries facets', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        const payload = decodePayload<SearchPayload>(msg.payload)
        receivedPayloads.push(payload)
        const isTextRequest = payload.params.term !== null

        const facets = isTextRequest
          ? {
              color: [
                { value: 'red', count: 5 },
                { value: 'blue', count: 3 },
              ],
            }
          : null

        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse(
              [{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }],
              facets,
            ),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery(
      'products',
      makeQueryParams({
        term: 'laptop',
        vector: makeVectorParams(),
        hybrid: makeHybridConfig(),
        facets: ['color'],
      }),
      makeDeps(table),
    )

    const textPayload = receivedPayloads.find(p => p.params.term !== null)
    const vectorPayload = receivedPayloads.find(p => p.params.term === null)

    expect(textPayload?.facetShardSize).not.toBeNull()
    expect(vectorPayload?.facetShardSize).toBeNull()

    expect(result.facets).not.toBeNull()
    expect(result.facets?.color).toBeDefined()
    expect(result.facets?.color[0]).toEqual({ value: 'red', count: 5 })
  })

  it('throws QUERY_PARTIAL_FAILURE for hybrid queries when allowPartialResults is false', async () => {
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

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-unreachable' })],
    ])

    const error = await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
      { allowPartialResults: false },
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('QUERY_PARTIAL_FAILURE')
  })

  it('maintains coverage invariant: queried + timedOut + failed <= totalPartitions', async () => {
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

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-unreachable' })],
      [2, makeAssignment({ primary: 'node-missing' })],
      [3, makeAssignment({ primary: 'node-a' })],
    ])

    const result = await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
      { allowPartialResults: true },
    )

    const { totalPartitions, queriedPartitions, timedOutPartitions, failedPartitions } = result.coverage
    expect(queriedPartitions + timedOutPartitions + failedPartitions).toBeLessThanOrEqual(totalPartitions)
    expect(queriedPartitions).toBeGreaterThanOrEqual(0)
    expect(timedOutPartitions).toBeGreaterThanOrEqual(0)
    expect(failedPartitions).toBeGreaterThanOrEqual(0)
  })
})
