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

describe('distributedQuery partial results and failures', () => {
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

  it('returns partial results when a node fails and allowPartialResults is true', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
})
