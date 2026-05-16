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
import {
  createSearchResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

describe('distributedQuery basic fan-out', () => {
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
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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

    setupDataNode(network, transports, 'node-b', (msg, respond) => {
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
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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

  it('clamps limit to MAX_QUERY_LIMIT', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
