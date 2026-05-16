import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import { decodePayload } from '../../../../distribution/query/codec'
import { decodeDistributedCursor, encodeDistributedCursor } from '../../../../distribution/query/cursor'
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

describe('distributedQuery cursor and searchAfter', () => {
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

  it('returns a cursor encoding the last result when results exist', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
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
    const capturedPayloads: SearchPayload[] = []
    const cursorValue = encodeDistributedCursor(5.5, 'doc-prev')

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
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

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].params.searchAfter).toBe(cursorValue)
  })

  it('broadcasts the same searchAfter to all data nodes', async () => {
    const capturedPayloads: SearchPayload[] = []
    const cursorValue = encodeDistributedCursor(7.0, 'doc-anchor')

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-a1', score: 6.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    setupDataNode(network, transports, 'node-b', (msg, respond) => {
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
