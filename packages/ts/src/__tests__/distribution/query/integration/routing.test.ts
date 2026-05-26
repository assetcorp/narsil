import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable, PartitionAssignment } from '../../../../distribution/coordinator/types'
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
import type {
  SearchPayload,
  SearchResultPayload,
  StatsPayload,
  StatsResultPayload,
  TransportMessage,
  WireQueryParams,
} from '../../../../distribution/transport/types'

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
    term: 'search terms',
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

interface MockDocument {
  id: string
  title: string
  score: number
  partitionId: number
}

function createDataNodeHandler(documents: MockDocument[]) {
  return (msg: TransportMessage, respond: (r: TransportMessage) => void) => {
    if (msg.type === QueryMessageTypes.STATS) {
      const statsPayload = decodePayload<StatsPayload>(msg.payload)
      const partitionDocs = documents.filter(d => statsPayload.partitionIds.includes(d.partitionId))
      const docFrequencies: Record<string, number> = {}
      for (const term of statsPayload.terms) {
        docFrequencies[term] = partitionDocs.filter(d => d.title.toLowerCase().includes(term.toLowerCase())).length
      }

      const statsResult: StatsResultPayload = {
        totalDocuments: partitionDocs.length,
        docFrequencies,
        totalFieldLengths: { title: partitionDocs.reduce((sum, d) => sum + d.title.length, 0) },
      }

      respond({
        type: QueryMessageTypes.STATS_RESULT,
        sourceId: msg.sourceId,
        requestId: msg.requestId,
        payload: encode(statsResult),
      })
      return
    }

    if (msg.type === QueryMessageTypes.SEARCH) {
      const searchPayload = decodePayload<SearchPayload>(msg.payload)
      const results = searchPayload.partitionIds.map(pid => {
        const partitionDocs = documents.filter(d => d.partitionId === pid).sort((a, b) => b.score - a.score)

        return {
          partitionId: pid,
          scored: partitionDocs.map(d => ({ docId: d.id, score: d.score, sortValues: null })),
          totalHits: partitionDocs.length,
        }
      })

      const resultPayload: SearchResultPayload = { results, facets: null }

      respond({
        type: QueryMessageTypes.SEARCH_RESULT,
        sourceId: msg.sourceId,
        requestId: msg.requestId,
        payload: encode(resultPayload),
      })
    }
  }
}

describe('distributed query integration', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  const transports: NodeTransport[] = []

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

  function setupNode(nodeId: string, docs: MockDocument[]): NodeTransport {
    const transport = createInMemoryTransport(nodeId, network)
    transports.push(transport)
    transport.listen(createDataNodeHandler(docs))
    return transport
  }

  it('two data nodes with documents return globally sorted results', async () => {
    const nodeADocs: MockDocument[] = [
      { id: 'product-1', title: 'Wireless Keyboard', score: 8.5, partitionId: 0 },
      { id: 'product-2', title: 'USB Mouse', score: 6.2, partitionId: 0 },
      { id: 'product-3', title: 'Monitor Stand', score: 4.0, partitionId: 1 },
    ]

    const nodeBDocs: MockDocument[] = [
      { id: 'product-4', title: 'Mechanical Keyboard', score: 9.1, partitionId: 2 },
      { id: 'product-5', title: 'Webcam HD', score: 7.3, partitionId: 2 },
      { id: 'product-6', title: 'Desk Lamp', score: 5.0, partitionId: 3 },
    ]

    setupNode('node-a', nodeADocs)
    setupNode('node-b', nodeBDocs)

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-a' })],
      [2, makeAssignment({ primary: 'node-b' })],
      [3, makeAssignment({ primary: 'node-b' })],
    ])

    const deps: QueryRoutingDeps = {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => table,
    }

    const result = await distributedQuery('products', makeQueryParams(), deps)

    expect(result.totalHits).toBe(6)
    expect(result.scored).toHaveLength(6)

    const scores = result.scored.map(s => s.score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1])
    }

    expect(result.scored[0].docId).toBe('product-4')
    expect(result.scored[0].score).toBe(9.1)
    expect(result.scored[1].docId).toBe('product-1')
    expect(result.scored[1].score).toBe(8.5)

    expect(result.coverage.totalPartitions).toBe(4)
    expect(result.coverage.queriedPartitions).toBe(4)
    expect(result.coverage.timedOutPartitions).toBe(0)
    expect(result.coverage.failedPartitions).toBe(0)
  })

  it('DFS mode collects stats from both nodes before searching', async () => {
    let nodeAStatsRequested = false
    let nodeBStatsRequested = false

    const nodeATransport = createInMemoryTransport('node-a', network)
    transports.push(nodeATransport)
    nodeATransport.listen((msg, respond) => {
      if (msg.type === QueryMessageTypes.STATS) {
        nodeAStatsRequested = true
        respond({
          type: QueryMessageTypes.STATS_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode({
            totalDocuments: 50,
            docFrequencies: { search: 20, terms: 15 },
            totalFieldLengths: { title: 250 },
          }),
        })
        return
      }

      respond({
        type: QueryMessageTypes.SEARCH_RESULT,
        sourceId: 'node-a',
        requestId: msg.requestId,
        payload: encode({
          results: [
            {
              partitionId: 0,
              scored: [{ docId: 'doc-a1', score: 5.0, sortValues: null }],
              totalHits: 1,
            },
          ],
          facets: null,
        }),
      })
    })

    const nodeBTransport = createInMemoryTransport('node-b', network)
    transports.push(nodeBTransport)
    nodeBTransport.listen((msg, respond) => {
      if (msg.type === QueryMessageTypes.STATS) {
        nodeBStatsRequested = true
        respond({
          type: QueryMessageTypes.STATS_RESULT,
          sourceId: 'node-b',
          requestId: msg.requestId,
          payload: encode({
            totalDocuments: 50,
            docFrequencies: { search: 25, terms: 10 },
            totalFieldLengths: { title: 300 },
          }),
        })
        return
      }

      respond({
        type: QueryMessageTypes.SEARCH_RESULT,
        sourceId: 'node-b',
        requestId: msg.requestId,
        payload: encode({
          results: [
            {
              partitionId: 1,
              scored: [{ docId: 'doc-b1', score: 6.0, sortValues: null }],
              totalHits: 1,
            },
          ],
          facets: null,
        }),
      })
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])

    const deps: QueryRoutingDeps = {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => table,
    }

    const result = await distributedQuery('products', makeQueryParams({ scoring: 'dfs' }), deps)

    expect(nodeAStatsRequested).toBe(true)
    expect(nodeBStatsRequested).toBe(true)
    expect(result.scored).toHaveLength(2)
    expect(result.scored[0].docId).toBe('doc-b1')
    expect(result.scored[1].docId).toBe('doc-a1')
  })

  it('handles mixed success and failure across nodes', async () => {
    setupNode('node-a', [{ id: 'doc-1', title: 'Available', score: 5.0, partitionId: 0 }])

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-unavailable' })],
    ])

    const deps: QueryRoutingDeps = {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => table,
    }

    const result = await distributedQuery('products', makeQueryParams(), deps, { allowPartialResults: true })

    expect(result.scored).toHaveLength(1)
    expect(result.scored[0].docId).toBe('doc-1')
    expect(result.coverage.queriedPartitions).toBe(1)
    expect(result.coverage.failedPartitions).toBe(1)
  })
})
