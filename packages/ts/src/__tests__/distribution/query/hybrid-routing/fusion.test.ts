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
import {
  makeAllocationTable,
  makeAssignment,
  makeHybridConfig,
  makeQueryParams,
  makeSearchResultResponse,
  makeVectorParams,
  setupDataNode,
} from './fixtures'

describe('distributed hybrid query - fusion and merging', () => {
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

  it('merges text and vector results separately then fuses with RRF', async () => {
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
                { docId: 'doc-b', score: 8.0 },
              ],
              totalHits: 2,
            },
          ])
        : makeSearchResultResponse([
            {
              partitionId: 0,
              scored: [
                { docId: 'doc-c', score: 0.95 },
                { docId: 'doc-a', score: 0.8 },
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
      makeQueryParams({
        term: 'laptop',
        vector: makeVectorParams(),
        hybrid: makeHybridConfig({ strategy: 'rrf', k: 60 }),
      }),
      makeDeps(table),
    )

    expect(result.scored.length).toBeGreaterThan(0)

    const docIds = result.scored.map(s => s.docId)
    expect(docIds).toContain('doc-a')
    expect(docIds).toContain('doc-b')
    expect(docIds).toContain('doc-c')

    const docAEntry = result.scored.find(s => s.docId === 'doc-a')
    const docBEntry = result.scored.find(s => s.docId === 'doc-b')
    const docCEntry = result.scored.find(s => s.docId === 'doc-c')
    expect(docAEntry).toBeDefined()
    expect(docBEntry).toBeDefined()
    expect(docCEntry).toBeDefined()

    if (docAEntry && docBEntry) {
      expect(docAEntry.score).toBeGreaterThan(docBEntry.score)
    }
  })

  it('merges text and vector results separately then fuses with linear combination', async () => {
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
                { docId: 'doc-b', score: 0.95 },
                { docId: 'doc-a', score: 0.4 },
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
      makeQueryParams({
        term: 'laptop',
        vector: makeVectorParams(),
        hybrid: makeHybridConfig({ strategy: 'linear', alpha: 0.5 }),
      }),
      makeDeps(table),
    )

    expect(result.scored.length).toBe(2)
    for (let i = 1; i < result.scored.length; i++) {
      expect(result.scored[i - 1].score).toBeGreaterThanOrEqual(result.scored[i].score)
    }
  })

  it('respects limit parameter on fused results', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type !== QueryMessageTypes.SEARCH) return
      const payload = decodePayload<SearchPayload>(msg.payload)
      const isTextRequest = payload.params.term !== null

      const result = isTextRequest
        ? makeSearchResultResponse([
            {
              partitionId: 0,
              scored: [
                { docId: 'doc-a', score: 10 },
                { docId: 'doc-b', score: 9 },
                { docId: 'doc-c', score: 8 },
                { docId: 'doc-d', score: 7 },
                { docId: 'doc-e', score: 6 },
              ],
              totalHits: 5,
            },
          ])
        : makeSearchResultResponse([
            {
              partitionId: 0,
              scored: [
                { docId: 'doc-f', score: 0.95 },
                { docId: 'doc-g', score: 0.9 },
                { docId: 'doc-h', score: 0.85 },
                { docId: 'doc-i', score: 0.8 },
                { docId: 'doc-j', score: 0.75 },
              ],
              totalHits: 5,
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
      makeQueryParams({
        term: 'laptop',
        vector: makeVectorParams(),
        hybrid: makeHybridConfig(),
        limit: 3,
      }),
      makeDeps(table),
    )

    expect(result.scored).toHaveLength(3)
  })

  it('counts totalHits only from the text fan-out to avoid double-counting', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type !== QueryMessageTypes.SEARCH) return
      const payload = decodePayload<SearchPayload>(msg.payload)
      const isTextRequest = payload.params.term !== null

      const result = isTextRequest
        ? makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-a', score: 10.0 }], totalHits: 100 }])
        : makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-a', score: 0.9 }], totalHits: 80 }])

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

    expect(result.totalHits).toBe(100)
  })
})
