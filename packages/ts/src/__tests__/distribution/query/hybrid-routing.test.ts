import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable, PartitionAssignment } from '../../../distribution/coordinator/types'
import { decodePayload } from '../../../distribution/query/codec'
import { decodeDistributedCursor, encodeDistributedCursor } from '../../../distribution/query/cursor'
import { distributedQuery } from '../../../distribution/query/routing'
import type { QueryRoutingDeps } from '../../../distribution/query/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
  QueryMessageTypes,
} from '../../../distribution/transport'
import type {
  SearchPayload,
  SearchResultPayload,
  StatsResultPayload,
  TransportMessage,
  WireHybridConfig,
  WireQueryParams,
  WireVectorQueryParams,
} from '../../../distribution/transport/types'
import { NarsilError } from '../../../errors'

function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'node-a',
    replicas: [],
    inSyncSet: ['node-a'],
    state: 'ACTIVE',
    primaryTerm: 1,
    ...overrides,
  }
}

function makeAllocationTable(
  assignments: Array<[number, PartitionAssignment]>,
  indexName = 'products',
): AllocationTable {
  return {
    indexName,
    version: 1,
    replicationFactor: 1,
    assignments: new Map(assignments),
  }
}

function makeVectorParams(): WireVectorQueryParams {
  return { field: 'embedding', value: [0.1, 0.2, 0.3], text: null, k: 10 }
}

function makeHybridConfig(overrides: Partial<WireHybridConfig> = {}): WireHybridConfig {
  return { strategy: 'rrf', k: 60, alpha: 0.5, ...overrides }
}

function makeQueryParams(overrides: Partial<WireQueryParams> = {}): WireQueryParams {
  return {
    term: 'test query',
    filters: null,
    sort: null,
    group: null,
    facets: null,
    facetSize: null,
    limit: 10,
    offset: 0,
    searchAfter: null,
    fields: null,
    boost: null,
    tolerance: null,
    threshold: null,
    scoring: 'local',
    vector: null,
    hybrid: null,
    ...overrides,
  }
}

function makeSearchResultResponse(
  partitionResults: Array<{ partitionId: number; scored: Array<{ docId: string; score: number }>; totalHits: number }>,
  facets: Record<string, Array<{ value: string; count: number }>> | null = null,
): SearchResultPayload {
  return {
    results: partitionResults.map(r => ({
      partitionId: r.partitionId,
      scored: r.scored.map(s => ({ docId: s.docId, score: s.score, sortValues: null })),
      totalHits: r.totalHits,
    })),
    facets,
  }
}

describe('distributed hybrid query', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  const transports: NodeTransport[] = []

  function setupDataNode(
    nodeId: string,
    handler: (msg: TransportMessage, respond: (r: TransportMessage) => void) => void,
  ): NodeTransport {
    const transport = createInMemoryTransport(nodeId, network)
    transports.push(transport)
    transport.listen(handler)
    return transport
  }

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

  it('sends two separate search messages to each data node for hybrid queries', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode('node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        const resultPayload = makeSearchResultResponse([
          { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
        ])
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(resultPayload),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(2)

    const textPayload = receivedPayloads.find(p => p.params.term !== null && p.params.vector === null)
    const vectorPayload = receivedPayloads.find(p => p.params.term === null && p.params.vector !== null)

    expect(textPayload).toBeDefined()
    expect(vectorPayload).toBeDefined()
    expect(textPayload?.params.hybrid).toBeNull()
    expect(vectorPayload?.params.hybrid).toBeNull()
  })

  it('sends two messages per node when multiple nodes exist', async () => {
    const nodeAPayloads: SearchPayload[] = []
    const nodeBPayloads: SearchPayload[] = []

    setupDataNode('node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        nodeAPayloads.push(decodePayload<SearchPayload>(msg.payload))
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

    setupDataNode('node-b', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        nodeBPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-b',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 1, scored: [{ docId: 'doc-2', score: 4.0 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])

    await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(nodeAPayloads).toHaveLength(2)
    expect(nodeBPayloads).toHaveLength(2)
  })

  it('merges text and vector results separately then fuses with RRF', async () => {
    setupDataNode('node-a', (msg, respond) => {
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
    setupDataNode('node-a', (msg, respond) => {
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

  it('follows the single-fan-out path for non-hybrid queries', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode('node-a', (msg, respond) => {
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
    await distributedQuery('products', makeQueryParams({ term: 'laptop', hybrid: null }), makeDeps(table))

    expect(receivedPayloads).toHaveLength(1)
    expect(receivedPayloads[0].params.term).toBe('laptop')
  })

  it('follows the single-fan-out path for vector-only queries without hybrid', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode('node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 0.9 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({ term: null, vector: makeVectorParams(), hybrid: null }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(1)
    expect(receivedPayloads[0].params.vector).not.toBeNull()
    expect(receivedPayloads[0].params.term).toBeNull()
  })

  it('reports worst-case coverage across both fan-outs', async () => {
    setupDataNode('node-a', (msg, respond) => {
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

    setupDataNode('node-a', (msg, respond) => {
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

  it('strips hybrid config from both text and vector fan-out params', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode('node-a', (msg, respond) => {
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

  it('respects limit parameter on fused results', async () => {
    setupDataNode('node-a', (msg, respond) => {
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

  it('produces a cursor from the last fused result', async () => {
    setupDataNode('node-a', (msg, respond) => {
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

    expect(result.cursor).not.toBeNull()
    const decoded = decodeDistributedCursor(result.cursor as string)
    const lastScored = result.scored[result.scored.length - 1]
    expect(decoded.s).toBe(lastScored.score)
    expect(decoded.d).toBe(lastScored.docId)
  })

  it('returns null cursor when hybrid search produces no results', async () => {
    setupDataNode('node-a', (msg, respond) => {
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

  it('throws QUERY_PARTIAL_FAILURE for hybrid queries when allowPartialResults is false', async () => {
    setupDataNode('node-a', (msg, respond) => {
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

  it('does not enter hybrid path when term is null (even if hybrid config is set)', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode('node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 0.9 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({ term: null, vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(1)
  })

  it('does not enter hybrid path when vector is null (even if hybrid config is set)', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode('node-a', (msg, respond) => {
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
      makeQueryParams({ term: 'laptop', vector: null, hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(1)
  })

  it('counts totalHits only from the text fan-out to avoid double-counting', async () => {
    setupDataNode('node-a', (msg, respond) => {
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

  it('preserves filters in both text and vector fan-out params', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode('node-a', (msg, respond) => {
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

  it('throws QUERY_ROUTING_FAILED when searchAfter is used with hybrid', async () => {
    setupDataNode('node-a', (msg, respond) => {
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
    const cursor = encodeDistributedCursor(5.0, 'doc-1')

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
    expect((error as NarsilError).code).toBe('QUERY_ROUTING_FAILED')
    expect((error as NarsilError).message).toContain('Cursor pagination is not supported for hybrid queries')
  })

  it('maintains coverage invariant: queried + timedOut + failed <= totalPartitions', async () => {
    setupDataNode('node-a', (msg, respond) => {
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

  it('performs DFS stats pre-pass then two fan-outs for hybrid with dfs scoring', async () => {
    const messageTypes: string[] = []

    setupDataNode('node-a', (msg, respond) => {
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
