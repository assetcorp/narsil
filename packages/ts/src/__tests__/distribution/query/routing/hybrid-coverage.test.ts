import { decode, encode } from '@msgpack/msgpack'
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
import { QueryMessageTypes, type TransportMessage } from '../../../../distribution/transport/types'
import {
  createSearchResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

type Leg = 'text' | 'vector'

function legOf(message: TransportMessage): Leg {
  const decoded = decode(message.payload) as { params: { term: string | null } }
  return decoded.params.term === null ? 'vector' : 'text'
}

describe('coverage for a hybrid query whose two legs lose different partitions', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  const transports: NodeTransport[] = []

  function makeDeps(allocationTable: AllocationTable): QueryRoutingDeps {
    return {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => allocationTable,
    }
  }

  function serveOneLeg(nodeId: string, partitionId: number, answeredLeg: Leg): void {
    setupDataNode(network, transports, nodeId, (message, respond) => {
      if (legOf(message) !== answeredLeg) {
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: nodeId,
          requestId: message.requestId,
          payload: encode({ results: 'not a list of partition results' }),
        })
        return
      }
      const payload = makeSearchResultResponse([
        { partitionId, scored: [{ docId: `doc-${partitionId}`, score: 4 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(payload, nodeId, message.requestId))
    })
  }

  function hybridParams() {
    return makeQueryParams({
      term: 'bench plane',
      vector: { field: 'embedding', value: [0.1, 0.2], text: null, similarity: null, metric: null, efSearch: null },
      hybrid: { strategy: 'rrf', k: 60, alpha: 0.5 },
    })
  }

  beforeEach(() => {
    network = createInMemoryNetwork()
    coordinatorTransport = createInMemoryTransport('coordinator', network)
    transports.push(coordinatorTransport)
  })

  afterEach(async () => {
    for (const transport of transports) {
      await transport.shutdown()
    }
    transports.length = 0
  })

  it('counts both partitions as failed when each leg loses a different one', async () => {
    serveOneLeg('node-a', 0, 'vector')
    serveOneLeg('node-b', 1, 'text')

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', inSyncSet: ['node-a'] })],
      [1, makeAssignment({ primary: 'node-b', inSyncSet: ['node-b'] })],
    ])

    const result = await distributedQuery('products', hybridParams(), makeDeps(table), {
      allowPartialResults: true,
    })

    expect(result.coverage).toEqual({
      totalPartitions: 2,
      queriedPartitions: 0,
      timedOutPartitions: 0,
      failedPartitions: 2,
    })
  })

  it('keeps the three counts within the partitions the query set out to read', async () => {
    serveOneLeg('node-a', 0, 'vector')
    serveOneLeg('node-b', 1, 'text')

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', inSyncSet: ['node-a'] })],
      [1, makeAssignment({ primary: 'node-b', inSyncSet: ['node-b'] })],
    ])

    const { coverage } = await distributedQuery('products', hybridParams(), makeDeps(table), {
      allowPartialResults: true,
    })

    expect(coverage.queriedPartitions + coverage.timedOutPartitions + coverage.failedPartitions).toBe(
      coverage.totalPartitions,
    )
  })

  it('reports full coverage when both legs answer for every partition', async () => {
    setupDataNode(network, transports, 'node-a', (message, respond) => {
      const payload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-0', score: 4 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(payload, 'node-a', message.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a', inSyncSet: ['node-a'] })]])

    const { coverage } = await distributedQuery('products', hybridParams(), makeDeps(table), {
      allowPartialResults: true,
    })

    expect(coverage).toEqual({
      totalPartitions: 1,
      queriedPartitions: 1,
      timedOutPartitions: 0,
      failedPartitions: 0,
    })
  })

  it('counts a partition no active copy serves as failed alongside a leg failure', async () => {
    serveOneLeg('node-a', 0, 'vector')

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', inSyncSet: ['node-a'] })],
      [1, makeAssignment({ primary: null, inSyncSet: [], state: 'UNASSIGNED' })],
    ])

    const { coverage } = await distributedQuery('products', hybridParams(), makeDeps(table), {
      allowPartialResults: true,
    })

    expect(coverage).toEqual({
      totalPartitions: 2,
      queriedPartitions: 0,
      timedOutPartitions: 0,
      failedPartitions: 2,
    })
  })
})
