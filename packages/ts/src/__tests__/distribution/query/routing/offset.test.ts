import { decode } from '@msgpack/msgpack'
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
import type { SearchPayload } from '../../../../distribution/transport/types'
import {
  createSearchResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

const NODE_A_SCORES = [9.0, 7.0, 5.0, 3.0, 1.0]
const NODE_B_SCORES = [8.0, 6.0, 4.0, 2.0]

describe('distributedQuery offset', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  const transports: NodeTransport[] = []
  const requestedPaging: Array<{ limit: number; offset: number }> = []

  function makeDeps(allocationTable: AllocationTable | null): QueryRoutingDeps {
    return {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => allocationTable,
    }
  }

  function respondWith(nodeId: string, partitionId: number, scores: number[]): void {
    setupDataNode(network, transports, nodeId, (msg, respond) => {
      const payload = decode(msg.payload) as SearchPayload
      requestedPaging.push({ limit: payload.params.limit, offset: payload.params.offset })
      const page = scores.slice(payload.params.offset, payload.params.offset + payload.params.limit)
      const resultPayload = makeSearchResultResponse([
        {
          partitionId,
          scored: page.map(score => ({ docId: `${nodeId}-${score}`, score })),
          totalHits: scores.length,
        },
      ])
      respond(createSearchResultMessage(resultPayload, nodeId, msg.requestId))
    })
  }

  beforeEach(() => {
    network = createInMemoryNetwork()
    coordinatorTransport = createInMemoryTransport('coordinator', network)
    transports.push(coordinatorTransport)
    requestedPaging.length = 0
  })

  afterEach(async () => {
    for (const t of transports) {
      await t.shutdown()
    }
    transports.length = 0
  })

  it('skips once after the merge rather than once on every node', async () => {
    respondWith('node-a', 0, NODE_A_SCORES)
    respondWith('node-b', 1, NODE_B_SCORES)

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', inSyncSet: ['node-a'] })],
      [1, makeAssignment({ primary: 'node-b', inSyncSet: ['node-b'] })],
    ])

    const result = await distributedQuery('products', makeQueryParams({ limit: 3, offset: 2 }), makeDeps(table))

    expect(requestedPaging).toEqual([
      { limit: 5, offset: 0 },
      { limit: 5, offset: 0 },
    ])
    expect(result.scored.map(entry => entry.score)).toEqual([7.0, 6.0, 5.0])
    expect(result.totalHits).toBe(NODE_A_SCORES.length + NODE_B_SCORES.length)
  })

  it('returns the same documents a single node would at the same offset', async () => {
    respondWith('node-a', 0, NODE_A_SCORES)
    respondWith('node-b', 1, NODE_B_SCORES)

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', inSyncSet: ['node-a'] })],
      [1, makeAssignment({ primary: 'node-b', inSyncSet: ['node-b'] })],
    ])

    const wholeRanking = [...NODE_A_SCORES, ...NODE_B_SCORES].sort((a, b) => b - a)

    for (let offset = 0; offset + 2 <= wholeRanking.length; offset++) {
      const result = await distributedQuery('products', makeQueryParams({ limit: 2, offset }), makeDeps(table))
      expect(result.scored.map(entry => entry.score)).toEqual(wholeRanking.slice(offset, offset + 2))
    }
  })
})
