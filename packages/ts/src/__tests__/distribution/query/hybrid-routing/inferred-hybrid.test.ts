import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wireParamsToLocal } from '../../../../distribution/cluster-node/query-conversion'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import { decodePayload } from '../../../../distribution/query/codec'
import type { QueryRoutingDeps } from '../../../../distribution/query/routing'
import { distributedQuery } from '../../../../distribution/query/routing'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
  QueryMessageTypes,
} from '../../../../distribution/transport'
import type { SearchPayload } from '../../../../distribution/transport/types'
import { NarsilError } from '../../../../errors'
import { encodePageCursor } from '../../../../search/cursor'
import { queryBindingOf } from '../../../../search/cursor-binding'
import {
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  makeVectorParams,
  setupDataNode,
} from './fixtures'

describe('hybrid inference without a hybrid block', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  const transports: NodeTransport[] = []
  const receivedPayloads: SearchPayload[] = []

  function makeDeps(table: AllocationTable): QueryRoutingDeps {
    return {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => table,
    }
  }

  function twoLegDataNode(): void {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      const payload = decodePayload<SearchPayload>(msg.payload)
      receivedPayloads.push(payload)
      const scored =
        payload.params.term !== null
          ? [
              { docId: 'text-1', score: 10 },
              { docId: 'both', score: 5 },
            ]
          : [
              { docId: 'vector-1', score: 0.9 },
              { docId: 'both', score: 0.8 },
            ]
      respond({
        type: QueryMessageTypes.SEARCH_RESULT,
        sourceId: 'node-a',
        requestId: msg.requestId,
        payload: encode(makeSearchResultResponse([{ partitionId: 0, scored, totalHits: scored.length }])),
      })
    })
  }

  const table = () => makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])

  beforeEach(() => {
    network = createInMemoryNetwork()
    coordinatorTransport = createInMemoryTransport('coordinator', network)
    transports.push(coordinatorTransport)
    receivedPayloads.length = 0
  })

  afterEach(async () => {
    for (const t of transports) {
      await t.shutdown()
    }
    transports.length = 0
  })

  it('fuses a term and vector query at the coordinator with the default strategy', async () => {
    twoLegDataNode()
    const params = makeQueryParams({ term: 'laptop', vector: makeVectorParams() })
    const result = await distributedQuery('products', params, makeDeps(table()))

    expect(receivedPayloads).toHaveLength(2)
    const textLeg = receivedPayloads.find(payload => payload.params.term !== null)
    const vectorLeg = receivedPayloads.find(payload => payload.params.term === null)
    expect(textLeg?.params.vector).toBeNull()
    expect(vectorLeg?.params.vector).not.toBeNull()
    expect(result.scored[0].docId).toBe('both')
    expect(result.scored.map(entry => entry.docId).sort()).toEqual(['both', 'text-1', 'vector-1'])
  })

  it('strips the mode from both fan-out legs', async () => {
    twoLegDataNode()
    const params = makeQueryParams({ term: 'laptop', vector: makeVectorParams(), mode: 'hybrid' })
    await distributedQuery('products', params, makeDeps(table()))

    expect(receivedPayloads).toHaveLength(2)
    for (const payload of receivedPayloads) {
      expect(payload.params.mode).toBeNull()
    }
  })

  it('rejects a cursor with SEARCH_INVALID_CURSOR', async () => {
    const params = makeQueryParams({ term: 'laptop', vector: makeVectorParams() })
    const cursor = encodePageCursor({
      anchor: 'doc-1',
      score: 5,
      sortKey: null,
      sortSignature: null,
      binding: queryBindingOf(wireParamsToLocal(params)),
    })
    const error = await distributedQuery('products', { ...params, searchAfter: cursor }, makeDeps(table())).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects a sort with SEARCH_INVALID_MODE', async () => {
    const params = makeQueryParams({
      term: 'laptop',
      vector: makeVectorParams(),
      sort: [{ field: 'price', direction: 'asc' }],
    })
    const error = await distributedQuery('products', params, makeDeps(table())).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_MODE')
  })
})
