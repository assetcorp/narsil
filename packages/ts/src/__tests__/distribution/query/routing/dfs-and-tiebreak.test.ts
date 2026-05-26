import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import type { QueryRoutingDeps } from '../../../../distribution/query/routing'
import { distributedQuery } from '../../../../distribution/query/routing'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
  QueryMessageTypes,
} from '../../../../distribution/transport'
import type { StatsResultPayload } from '../../../../distribution/transport/types'
import { NarsilError } from '../../../../errors'
import {
  createSearchResultMessage,
  createStatsResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

describe('distributedQuery DFS mode and tiebreakers', () => {
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

  it('handles DFS mode by collecting stats before searching', async () => {
    let statsReceived = false

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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

    setupDataNode(network, transports, 'node-b', (msg, respond) => {
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
})
