import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable, PartitionAssignment } from '../../../distribution/coordinator/types'
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

    await expect(distributedQuery('products', params, deps)).rejects.toThrow(NarsilError)
    try {
      await distributedQuery('products', params, deps)
    } catch (e) {
      expect(e).toBeInstanceOf(NarsilError)
      expect((e as NarsilError).code).toBe('QUERY_ROUTING_FAILED')
    }
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

    await expect(
      distributedQuery('products', makeQueryParams(), makeDeps(table), { allowPartialResults: false }),
    ).rejects.toThrow(NarsilError)

    try {
      await distributedQuery('products', makeQueryParams(), makeDeps(table), { allowPartialResults: false })
    } catch (e) {
      expect((e as NarsilError).code).toBe('QUERY_PARTIAL_FAILURE')
    }
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

    await expect(
      distributedQuery('products', makeQueryParams(), makeDeps(table), { allowPartialResults: false }),
    ).rejects.toThrow(NarsilError)

    try {
      await distributedQuery('products', makeQueryParams(), makeDeps(table), { allowPartialResults: false })
    } catch (e) {
      expect((e as NarsilError).code).toBe('QUERY_NO_ACTIVE_REPLICA')
    }
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

    await expect(
      distributedQuery('products', makeQueryParams({ scoring: 'dfs' }), makeDeps(table), {
        allowPartialResults: true,
      }),
    ).rejects.toThrow(NarsilError)

    try {
      await distributedQuery('products', makeQueryParams({ scoring: 'dfs' }), makeDeps(table), {
        allowPartialResults: true,
      })
    } catch (e) {
      expect((e as NarsilError).code).toBe('QUERY_NODE_TIMEOUT')
    }
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
})
