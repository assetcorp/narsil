import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable, PartitionAssignment } from '../../../distribution/coordinator/types'
import { decodePayload } from '../../../distribution/query/codec'
import { decodeDistributedCursor, encodeDistributedCursor } from '../../../distribution/query/cursor'
import type { QueryRoutingDeps } from '../../../distribution/query/routing'
import { distributedQuery } from '../../../distribution/query/routing'
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
  WireQueryParams,
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

function createSearchResultMessage(
  payload: SearchResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.SEARCH_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

function createStatsResultMessage(payload: StatsResultPayload, sourceId: string, requestId: string): TransportMessage {
  return {
    type: QueryMessageTypes.STATS_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

describe('distributedQuery', () => {
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

  it('throws QUERY_ROUTING_FAILED when no allocation table exists', async () => {
    const deps = makeDeps(null)
    const params = makeQueryParams()

    const error = await distributedQuery('products', params, deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('QUERY_ROUTING_FAILED')
  })

  it('returns empty results for an index with no assignments', async () => {
    const table = makeAllocationTable([])
    const deps = makeDeps(table)
    const result = await distributedQuery('products', makeQueryParams(), deps)

    expect(result.scored).toEqual([])
    expect(result.totalHits).toBe(0)
    expect(result.facets).toBeNull()
    expect(result.coverage.totalPartitions).toBe(0)
  })

  it('queries a single node with 3 partitions and merges results', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [
            { docId: 'doc-1', score: 5.0 },
            { docId: 'doc-3', score: 3.0 },
          ],
          totalHits: 2,
        },
        { partitionId: 1, scored: [{ docId: 'doc-4', score: 4.5 }], totalHits: 1 },
        { partitionId: 2, scored: [{ docId: 'doc-2', score: 4.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-a' })],
      [2, makeAssignment({ primary: 'node-a' })],
    ])

    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table))

    expect(result.totalHits).toBe(4)
    expect(result.scored).toHaveLength(4)
    expect(result.scored[0].docId).toBe('doc-1')
    expect(result.scored[0].score).toBe(5.0)
    expect(result.scored[1].docId).toBe('doc-4')
    expect(result.scored[1].score).toBe(4.5)
    expect(result.scored[2].docId).toBe('doc-2')
    expect(result.scored[3].docId).toBe('doc-3')
    expect(result.coverage.totalPartitions).toBe(3)
    expect(result.coverage.queriedPartitions).toBe(3)
    expect(result.coverage.failedPartitions).toBe(0)
    expect(result.coverage.timedOutPartitions).toBe(0)
  })

  it('fans out to two nodes and merges results sorted by score', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [
            { docId: 'doc-1', score: 10.0 },
            { docId: 'doc-2', score: 6.0 },
          ],
          totalHits: 2,
        },
        { partitionId: 1, scored: [{ docId: 'doc-3', score: 8.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    setupDataNode('node-b', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 2,
          scored: [
            { docId: 'doc-4', score: 9.0 },
            { docId: 'doc-5', score: 7.0 },
          ],
          totalHits: 2,
        },
        { partitionId: 3, scored: [{ docId: 'doc-6', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-b', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-a' })],
      [2, makeAssignment({ primary: 'node-b' })],
      [3, makeAssignment({ primary: 'node-b' })],
    ])

    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table))

    expect(result.totalHits).toBe(6)
    expect(result.scored).toHaveLength(6)
    expect(result.scored.map(s => s.docId)).toEqual(['doc-1', 'doc-4', 'doc-3', 'doc-5', 'doc-2', 'doc-6'])
    expect(result.coverage.totalPartitions).toBe(4)
    expect(result.coverage.queriedPartitions).toBe(4)
  })

  it('respects limit parameter and truncates results', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [
            { docId: 'doc-1', score: 10.0 },
            { docId: 'doc-2', score: 9.0 },
            { docId: 'doc-3', score: 8.0 },
            { docId: 'doc-4', score: 7.0 },
            { docId: 'doc-5', score: 6.0 },
          ],
          totalHits: 5,
        },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery('products', makeQueryParams({ limit: 3 }), makeDeps(table))

    expect(result.scored).toHaveLength(3)
    expect(result.totalHits).toBe(5)
  })

  it('merges facets from multiple nodes by summing counts', async () => {
    setupDataNode('node-a', (msg, respond) => {
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

    setupDataNode('node-b', (msg, respond) => {
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

  it('returns partial results when a node fails and allowPartialResults is true', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])

    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table), { allowPartialResults: true })

    expect(result.scored).toHaveLength(1)
    expect(result.scored[0].docId).toBe('doc-1')
    expect(result.coverage.totalPartitions).toBe(2)
    expect(result.coverage.queriedPartitions).toBe(1)
    expect(result.coverage.failedPartitions).toBe(1)
  })

  it('throws QUERY_PARTIAL_FAILURE when node fails and allowPartialResults is false', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])

    const error = await distributedQuery('products', makeQueryParams(), makeDeps(table), {
      allowPartialResults: false,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('QUERY_PARTIAL_FAILURE')
  })

  it('throws QUERY_NO_ACTIVE_REPLICA when partitions are unavailable and allowPartialResults is false', async () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ state: 'ACTIVE', primary: 'node-a' })],
      [1, makeAssignment({ state: 'INITIALISING' })],
    ])

    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([{ partitionId: 0, scored: [], totalHits: 0 }])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const error = await distributedQuery('products', makeQueryParams(), makeDeps(table), {
      allowPartialResults: false,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('QUERY_NO_ACTIVE_REPLICA')
  })

  it('returns results with coverage showing unavailable partitions when allowPartialResults is true', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ state: 'ACTIVE', primary: 'node-a' })],
      [1, makeAssignment({ state: 'INITIALISING' })],
    ])

    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table))

    expect(result.scored).toHaveLength(1)
    expect(result.coverage.totalPartitions).toBe(2)
    expect(result.coverage.queriedPartitions).toBe(1)
    expect(result.coverage.failedPartitions).toBe(1)
  })

  it('handles DFS mode by collecting stats before searching', async () => {
    let statsReceived = false

    setupDataNode('node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.STATS) {
        statsReceived = true
        const statsResult: StatsResultPayload = {
          totalDocuments: 100,
          docFrequencies: { test: 50, query: 30 },
          totalFieldLengths: { title: 500, body: 2000 },
        }
        respond(createStatsResultMessage(statsResult, 'node-a', msg.requestId))
        return
      }

      if (msg.type === QueryMessageTypes.SEARCH) {
        const resultPayload = makeSearchResultResponse([
          { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
        ])
        respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery('products', makeQueryParams({ scoring: 'dfs' }), makeDeps(table))

    expect(statsReceived).toBe(true)
    expect(result.scored).toHaveLength(1)
  })

  it('uses tiebreaker on docId for entries with equal scores', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [
            { docId: 'doc-b', score: 5.0 },
            { docId: 'doc-d', score: 5.0 },
          ],
          totalHits: 2,
        },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    setupDataNode('node-b', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 1,
          scored: [
            { docId: 'doc-a', score: 5.0 },
            { docId: 'doc-c', score: 5.0 },
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

    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table))

    expect(result.scored.map(s => s.docId)).toEqual(['doc-a', 'doc-b', 'doc-c', 'doc-d'])
  })

  it('handles all partitions failing gracefully with allowPartialResults', async () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-x' })],
      [1, makeAssignment({ primary: 'node-y' })],
    ])

    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table), {
      allowPartialResults: true,
    })

    expect(result.scored).toEqual([])
    expect(result.totalHits).toBe(0)
    expect(result.facets).toBeNull()
    expect(result.coverage.totalPartitions).toBe(2)
    expect(result.coverage.queriedPartitions).toBe(0)
    expect(result.coverage.failedPartitions).toBe(2)
  })

  it('throws QUERY_NODE_TIMEOUT when all DFS stats requests fail', async () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-x' })],
      [1, makeAssignment({ primary: 'node-y' })],
    ])

    const error = await distributedQuery('products', makeQueryParams({ scoring: 'dfs' }), makeDeps(table), {
      allowPartialResults: true,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('QUERY_NODE_TIMEOUT')
  })

  it('clamps limit to MAX_QUERY_LIMIT', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])

    const resultNegative = await distributedQuery('products', makeQueryParams({ limit: -5 }), makeDeps(table))
    expect(resultNegative.scored).toHaveLength(0)

    const resultHuge = await distributedQuery('products', makeQueryParams({ limit: 999_999 }), makeDeps(table))
    expect(resultHuge.scored).toHaveLength(1)
  })

  it('includes facetShardSize in the search payload when facets are requested', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'] }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBe(Math.ceil(10 * 1.5) + 10)
  })

  it('computes facetShardSize from params.facetSize when provided', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['category'], facetSize: 20 }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBe(Math.ceil(20 * 1.5) + 10)
  })

  it('computes facetShardSize from config.defaultFacetSize when params.facetSize is null', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['brand'], facetSize: null }), makeDeps(table), {
      defaultFacetSize: 50,
    })

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBe(Math.ceil(50 * 1.5) + 10)
  })

  it('truncates merged facets to facetSize', async () => {
    const manyBuckets = Array.from({ length: 30 }, (_, i) => ({
      value: `color-${String(i).padStart(2, '0')}`,
      count: 30 - i,
    }))

    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse(
        [{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }],
        { color: manyBuckets.slice(0, 15) },
      )
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    setupDataNode('node-b', (msg, respond) => {
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

    setupDataNode('node-a', (msg, respond) => {
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

  it('clamps facetSize: 0 to 1', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'], facetSize: 0 }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBe(Math.ceil(1 * 1.5) + 10)
  })

  it('clamps facetSize: -1 to 1', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'], facetSize: -1 }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBe(Math.ceil(1 * 1.5) + 10)
  })

  it('falls back to default when facetSize is NaN', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'], facetSize: NaN }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBe(Math.ceil(10 * 1.5) + 10)
  })

  it('clamps facetSize: 999_999 to MAX_FACET_SIZE', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'], facetSize: 999_999 }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBe(Math.ceil(1_000 * 1.5) + 10)
  })

  it('does not compute facetShardSize when no facets are requested', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: null }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBeNull()
  })

  it('does not compute facetShardSize when facets array is empty', async () => {
    let capturedPayload: SearchPayload | null = null

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: [] }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).facetShardSize).toBeNull()
  })

  it('returns a cursor encoding the last result when results exist', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [
            { docId: 'doc-1', score: 10.0 },
            { docId: 'doc-2', score: 7.0 },
            { docId: 'doc-3', score: 3.5 },
          ],
          totalHits: 3,
        },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table))

    expect(result.cursor).not.toBeNull()
    const decoded = decodeDistributedCursor(result.cursor as string)
    expect(decoded.s).toBe(3.5)
    expect(decoded.d).toBe('doc-3')
  })

  it('returns cursor encoding the last result after limit truncation', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [
            { docId: 'doc-1', score: 10.0 },
            { docId: 'doc-2', score: 8.0 },
            { docId: 'doc-3', score: 6.0 },
            { docId: 'doc-4', score: 4.0 },
            { docId: 'doc-5', score: 2.0 },
          ],
          totalHits: 5,
        },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery('products', makeQueryParams({ limit: 3 }), makeDeps(table))

    expect(result.scored).toHaveLength(3)
    expect(result.cursor).not.toBeNull()
    const decoded = decodeDistributedCursor(result.cursor as string)
    expect(decoded.s).toBe(6.0)
    expect(decoded.d).toBe('doc-3')
  })

  it('returns cursor: null when no scored entries exist', async () => {
    setupDataNode('node-a', (msg, respond) => {
      const resultPayload = makeSearchResultResponse([{ partitionId: 0, scored: [], totalHits: 0 }])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table))

    expect(result.scored).toHaveLength(0)
    expect(result.cursor).toBeNull()
  })

  it('returns cursor: null for empty assignment table', async () => {
    const table = makeAllocationTable([])
    const result = await distributedQuery('products', makeQueryParams(), makeDeps(table))

    expect(result.cursor).toBeNull()
  })

  it('passes searchAfter through to data nodes unchanged', async () => {
    let capturedPayload: SearchPayload | null = null
    const cursorValue = encodeDistributedCursor(5.5, 'doc-prev')

    setupDataNode('node-a', (msg, respond) => {
      capturedPayload = decodePayload<SearchPayload>(msg.payload)
      const resultPayload = makeSearchResultResponse([
        {
          partitionId: 0,
          scored: [{ docId: 'doc-next', score: 4.0 }],
          totalHits: 1,
        },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ searchAfter: cursorValue }), makeDeps(table))

    expect(capturedPayload).not.toBeNull()
    expect((capturedPayload as SearchPayload).params.searchAfter).toBe(cursorValue)
  })

  it('broadcasts the same searchAfter to all data nodes', async () => {
    const capturedPayloads: SearchPayload[] = []
    const cursorValue = encodeDistributedCursor(7.0, 'doc-anchor')

    setupDataNode('node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-a1', score: 6.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    setupDataNode('node-b', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 1, scored: [{ docId: 'doc-b1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-b', msg.requestId))
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])

    await distributedQuery('products', makeQueryParams({ searchAfter: cursorValue }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(2)
    expect(capturedPayloads[0].params.searchAfter).toBe(cursorValue)
    expect(capturedPayloads[1].params.searchAfter).toBe(cursorValue)
  })
})

describe('distributed cursor encode/decode', () => {
  it('round-trips score and docId through encode and decode', () => {
    const encoded = encodeDistributedCursor(4.523, 'doc-id-123')
    const decoded = decodeDistributedCursor(encoded)
    expect(decoded.s).toBe(4.523)
    expect(decoded.d).toBe('doc-id-123')
  })

  it('handles zero score', () => {
    const encoded = encodeDistributedCursor(0, 'doc-zero')
    const decoded = decodeDistributedCursor(encoded)
    expect(decoded.s).toBe(0)
    expect(decoded.d).toBe('doc-zero')
  })

  it('handles negative score', () => {
    const encoded = encodeDistributedCursor(-3.14, 'doc-neg')
    const decoded = decodeDistributedCursor(encoded)
    expect(decoded.s).toBe(-3.14)
    expect(decoded.d).toBe('doc-neg')
  })

  it('handles special characters in docId', () => {
    const encoded = encodeDistributedCursor(1.0, 'doc/with"special\\chars')
    const decoded = decodeDistributedCursor(encoded)
    expect(decoded.d).toBe('doc/with"special\\chars')
  })

  it('rejects invalid base64', () => {
    let error: unknown
    try {
      decodeDistributedCursor('not-valid-base64!!!')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects valid base64 with invalid JSON', () => {
    const badJson = Buffer.from('not json at all').toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(badJson)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects a JSON array instead of an object', () => {
    const arrayJson = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(arrayJson)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects missing "s" field', () => {
    const noScore = Buffer.from(JSON.stringify({ d: 'doc-1' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(noScore)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects missing "d" field', () => {
    const noDocId = Buffer.from(JSON.stringify({ s: 5.0 })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(noDocId)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects non-finite score (Infinity)', () => {
    const infScore = Buffer.from(JSON.stringify({ s: 'Infinity', d: 'doc-1' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(infScore)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects non-finite score (NaN)', () => {
    const nanCursor = Buffer.from(JSON.stringify({ s: 'NaN', d: 'doc-1' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(nanCursor)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects null score', () => {
    const nullScore = Buffer.from(JSON.stringify({ s: null, d: 'doc-1' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(nullScore)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects empty string docId', () => {
    const emptyDocId = Buffer.from(JSON.stringify({ s: 5.0, d: '' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(emptyDocId)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects numeric docId', () => {
    const numericDocId = Buffer.from(JSON.stringify({ s: 5.0, d: 42 })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(numericDocId)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects null as the top-level value', () => {
    const nullCursor = Buffer.from('null').toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(nullCursor)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })
})
